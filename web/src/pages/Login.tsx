// Email + strong password, with "remember me".
// First time (or forgot password): we email a link, and the link opens the "choose password" screen.
import { useState } from "react";
import { setRemember, supabase } from "../lib/supabase";
import { Button, Card, Eyebrow, Field, Input } from "../components/ui";

export const SET_PASSWORD_FLAG = "arli-set-password";

export function passwordProblem(p: string) {
  if (p.length < 10) return "לפחות 10 תווים";
  if (!/[A-Za-z֐-׿]/.test(p) || !/\d/.test(p)) return "צריך גם אותיות וגם ספרות";
  if (!/[^A-Za-z0-9֐-׿]/.test(p)) return "צריך גם סימן אחד, למשל ! או #";
  return "";
}

const ERRORS: Record<string, string> = {
  "Invalid login credentials": "המייל או הסיסמה לא נכונים.",
  "Email not confirmed": "המייל עוד לא אושר. בדקי את תיבת הדואר.",
};

export default function Login() {
  const [mode, setMode] = useState<"login" | "link">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRem] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "error" | "ok"; text: string } | null>(null);

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    setRemember(remember);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) setMsg({ kind: "error", text: ERRORS[error.message] ?? error.message });
  }

  async function sendLink(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    setRemember(remember);
    // A one-time sign-in link. It creates the account on first use; the app then asks to choose a password.
    // Remember (on this device) that after the link we should ask for a new password.
    try { localStorage.setItem(SET_PASSWORD_FLAG, "1"); } catch { /* ignore */ }
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } });
    setBusy(false);
    setMsg(error ? { kind: "error", text: error.message } : { kind: "ok", text: "שלחנו קישור למייל. אחרי הלחיצה עליו תבחרי סיסמה." });
  }

  return (
    <div className="grid min-h-dvh place-items-center px-[var(--gutter)] py-10">
      <div className="w-full max-w-md">
        <Eyebrow>aRLi · ניהול</Eyebrow>
        <h1 className="mb-8 mt-1 text-[clamp(38px,5vw,64px)] font-semibold leading-[1.05] tracking-[-0.02em]">
          בונים את <span className="text-pink">aRLi.</span>
        </h1>
        <Card>
          <form onSubmit={mode === "login" ? login : sendLink} className="space-y-5">
            <Field label="מייל">
              <Input type="email" dir="ltr" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@gmail.com" />
            </Field>
            {mode === "login" && (
              <Field label="סיסמה">
                <Input type="password" dir="ltr" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </Field>
            )}
            <label className="flex cursor-pointer items-center gap-2.5 text-[15px]">
              <input type="checkbox" checked={remember} onChange={(e) => setRem(e.target.checked)} className="size-4 accent-[var(--pink)]" />
              זכרי אותי במכשיר הזה
            </label>
            {msg && <p className={`text-[14px] ${msg.kind === "error" ? "text-error" : "text-pink-soft"}`}>{msg.text}</p>}
            <Button arrow className="group" disabled={busy}>
              {busy ? "רגע…" : mode === "login" ? "כניסה" : "שלחו לי קישור"}
            </Button>
          </form>
          <button className="mt-5 text-[14px] text-mute hover:text-bone" onClick={() => { setMode(mode === "login" ? "link" : "login"); setMsg(null); }}>
            {mode === "login" ? "כניסה ראשונה או ששכחת סיסמה?" : "חזרה לכניסה עם סיסמה"}
          </button>
        </Card>
      </div>
    </div>
  );
}

export function SetPassword({ onDone }: { onDone: () => void }) {
  const [p1, setP1] = useState("");
  const [p2, setP2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const problem = p1 ? passwordProblem(p1) : "";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (passwordProblem(p1)) return setError(passwordProblem(p1));
    if (p1 !== p2) return setError("הסיסמאות לא זהות");
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: p1 });
    setBusy(false);
    if (error) return setError(error.message);
    try { localStorage.removeItem(SET_PASSWORD_FLAG); } catch { /* ignore */ }
    onDone();
  }

  return (
    <div className="grid min-h-dvh place-items-center px-[var(--gutter)] py-10">
      <div className="w-full max-w-md">
        <Eyebrow>סיסמה</Eyebrow>
        <h1 className="mb-8 mt-1 text-[clamp(32px,4vw,52px)] font-semibold leading-[1.08] tracking-[-0.02em]">בחרי סיסמה חזקה.</h1>
        <Card>
          <form onSubmit={submit} className="space-y-5">
            <Field label="סיסמה חדשה" hint="לפחות 10 תווים, עם אותיות, ספרות וסימן">
              <Input type="password" dir="ltr" required autoComplete="new-password" value={p1} onChange={(e) => setP1(e.target.value)} />
            </Field>
            {problem && <p className="-mt-3 text-[13px] text-mute">חסר: {problem}</p>}
            <Field label="שוב, לאימות">
              <Input type="password" dir="ltr" required autoComplete="new-password" value={p2} onChange={(e) => setP2(e.target.value)} />
            </Field>
            {error && <p className="text-[14px] text-error">{error}</p>}
            <Button arrow className="group" disabled={busy}>{busy ? "שומרת…" : "שמירה וכניסה"}</Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
