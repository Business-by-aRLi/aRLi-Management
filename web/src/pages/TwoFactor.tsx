// Second step after the email link: a 6-digit code from an authenticator app (TOTP).
// First time: scan a QR code to enroll. Every next time: just type the code.
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { Button, Card, Eyebrow, Field, Input } from "../components/ui";

export default function TwoFactor({ onVerified }: { onVerified: () => void }) {
  const [factorId, setFactorId] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.mfa.listFactors();
      const verified = data?.totp.find((f) => f.status === "verified");
      if (verified) { setFactorId(verified.id); return; }
      // Clean up a half-finished enrollment, then start a new one.
      for (const f of data?.all ?? []) if (f.status !== "verified") await supabase.auth.mfa.unenroll({ factorId: f.id });
      const { data: enrolled, error } = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: `aRLi ${Date.now()}` });
      if (error) { setError(error.message); return; }
      setFactorId(enrolled.id);
      setQr(enrolled.totp.qr_code);
      setSecret(enrolled.totp.secret);
    })();
  }, []);

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    if (!factorId) return;
    setBusy(true); setError("");
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.trim() });
    setBusy(false);
    if (error) setError("הקוד לא נכון או שפג תוקפו. נסי את הקוד הבא שמופיע באפליקציה.");
    else onVerified();
  }

  return (
    <div className="grid min-h-dvh place-items-center px-[var(--gutter)] py-10">
      <div className="w-full max-w-md">
        <Eyebrow>אימות דו-שלבי</Eyebrow>
        <h1 className="mb-8 mt-1 text-[clamp(32px,4vw,52px)] font-semibold leading-[1.08] tracking-[-0.02em]">
          {qr ? "עוד צעד אחד, פעם אחת." : "רק לוודא שזו את."}
        </h1>
        <Card>
          <form onSubmit={verify} className="space-y-5">
            {qr && (
              <div className="space-y-3">
                <p className="text-[15px] text-mute">סרקי את הקוד באפליקציית אימות, כמו Google Authenticator או Microsoft Authenticator. מהפעם הבאה רק תקלידי את הקוד שמופיע בה.</p>
                <div className="mx-auto w-fit rounded-[14px] bg-white p-3"><img src={qr} alt="קוד QR לאימות" className="size-44" /></div>
                {secret && <p className="text-center text-[13px] text-mute-2">אי אפשר לסרוק? הקלידי באפליקציה: <bdi className="font-mono text-bone">{secret}</bdi></p>}
              </div>
            )}
            <Field label="קוד בן 6 ספרות">
              <Input inputMode="numeric" autoComplete="one-time-code" dir="ltr" maxLength={6} required autoFocus
                className="text-center font-mono text-[22px] tracking-[0.4em]" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
            </Field>
            {error && <p className="text-[14px] text-error">{error}</p>}
            <div className="flex items-center justify-between gap-3">
              <Button arrow className="group" disabled={busy || code.length !== 6 || !factorId}>{busy ? "בודקת…" : "כניסה"}</Button>
              <Button type="button" variant="quiet" onClick={() => supabase.auth.signOut()}>יציאה</Button>
            </div>
          </form>
        </Card>
      </div>
    </div>
  );
}
