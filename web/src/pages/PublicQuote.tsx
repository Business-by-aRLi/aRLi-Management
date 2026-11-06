// The page the client opens from the link: the quote document, and approve / decline at the bottom.
// No sign-in: the token in the address is the only key, and the database shows nothing else through it.
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { getPublicQuote, respondToQuote, type PublicQuote as PQ } from "../lib/data";
import { supabase } from "../lib/supabase";
import { date } from "../lib/format";
import { QuoteDocument } from "../components/QuoteDocument";

export default function PublicQuote() {
  const { token = "" } = useParams();
  const [q, setQ] = useState<PQ | null | undefined>(undefined);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [declining, setDeclining] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = "light";
    (async () => {
      // A partner who is signed in sees the page without it counting as the client's view.
      const { data } = await supabase.auth.getSession();
      try {
        const res = await getPublicQuote(token, !data.session);
        setQ(res);
        if (res) document.title = `הצעת מחיר · ${res.title}`;
      } catch { setQ(null); }
    })();
  }, [token]);

  if (q === undefined) return <div className="qdoc min-h-dvh" />;
  if (!q) {
    return (
      <div className="qdoc grid min-h-dvh place-items-center p-6 text-center">
        <div><p className="text-[22px] font-semibold">ההצעה אינה זמינה.</p><p className="mt-2" style={{ color: "var(--q-mute)" }}>אם קיבלת קישור מאיתנו, נשמח שתכתבו לנו ונשלח חדש.</p></div>
      </div>
    );
  }

  const respond = async (approve: boolean) => {
    setError("");
    if (approve && !name.trim()) return setError("נשמח לשם מלא לפני האישור.");
    setBusy(true);
    try {
      const status = await respondToQuote(token, approve, name, note);
      setQ({ ...q, status, signer_name: name.trim() || null, responded_at: new Date().toISOString() });
    } catch (e) {
      const m = (e as Error).message;
      setError(m.includes("expired") ? "תוקף ההצעה הסתיים. כתבו לנו ונעדכן אותה." : "משהו השתבש. אפשר לנסות שוב בעוד רגע.");
    } finally { setBusy(false); }
  };

  const done = q.status === "approved" || q.status === "rejected";
  return (
    <div className="qdoc min-h-dvh">
      <QuoteDocument q={{ ...q, sections: q.sections ?? [] }}>
        <section className="q-respond" aria-label="תשובה להצעה">
          {done ? (
            <div>
              <p className="text-[22px] font-semibold">{q.status === "approved" ? "ההצעה אושרה. תודה!" : "קיבלנו את התשובה, תודה."}</p>
              <p className="mt-1" style={{ color: "var(--q-mute)" }}>
                {q.status === "approved"
                  ? `אושרה${q.signer_name ? ` על ידי ${q.signer_name}` : ""}${q.responded_at ? ` ב-${date(q.responded_at)}` : ""}. נחזור אלייך בקרוב לתיאום הצעד הבא.`
                  : "אם משהו ישתנה, אנחנו כאן."}
              </p>
            </div>
          ) : q.expired ? (
            <p className="text-[18px] font-semibold">תוקף ההצעה הסתיים ב-{date(q.valid_until)}. כתבו לנו ונעדכן אותה בשמחה.</p>
          ) : (
            <div className="grid gap-4">
              <p className="text-[22px] font-semibold leading-tight">{declining ? "רוצה לספר לנו למה?" : "מתאים לך? מאשרים כאן."}</p>
              {!declining && (
                <label className="block"><span className="mb-1.5 block text-[14px] font-medium">שם מלא</span>
                  <input className="q-input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></label>
              )}
              <label className="block"><span className="mb-1.5 block text-[14px] font-medium">{declining ? "מה היה חסר, או מה לשנות" : "הערה (לא חובה)"}</span>
                <textarea className="q-input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></label>
              {error && <p className="text-[14px]" style={{ color: "#B42318" }}>{error}</p>}
              <div className="flex flex-wrap gap-3">
                {declining ? (
                  <>
                    <button className="q-btn yes" disabled={busy} onClick={() => respond(false)}>שליחה</button>
                    <button className="q-btn no" onClick={() => setDeclining(false)}>חזרה</button>
                  </>
                ) : (
                  <>
                    <button className="q-btn yes" disabled={busy} onClick={() => respond(true)}>אישור ההצעה</button>
                    <button className="q-btn no" onClick={() => setDeclining(true)}>לא הפעם</button>
                  </>
                )}
              </div>
              <p className="text-[12.5px]" style={{ color: "var(--q-faint)" }}>האישור נשמר אצלנו עם השם והתאריך, ומחליף חתימה על נייר.</p>
            </div>
          )}
        </section>
      </QuoteDocument>
    </div>
  );
}
