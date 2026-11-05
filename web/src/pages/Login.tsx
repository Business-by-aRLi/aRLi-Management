import { useState } from "react";
import { supabase } from "../lib/supabase";
import { Button, Card, Eyebrow, Field, Input } from "../components/ui";

export default function Login() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState("sending");
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } });
    if (error) { setError(error.message); setState("error"); } else setState("sent");
  }

  return (
    <div className="grid min-h-dvh place-items-center px-[var(--gutter)]">
      <div className="w-full max-w-md">
        <Eyebrow>aRLi · ניהול</Eyebrow>
        <h1 className="mb-8 mt-1 text-[clamp(38px,5vw,64px)] font-semibold leading-[1.05] tracking-[-0.02em]">
          הכול <span className="text-pink">במקום אחד.</span>
        </h1>
        <Card>
          {state === "sent" ? (
            <p className="text-[18px]">שלחנו קישור כניסה ל-<bdi>{email}</bdi>. פתחי את המייל ולחצי עליו.</p>
          ) : (
            <form onSubmit={submit} className="space-y-5">
              <Field label="מייל">
                <Input type="email" dir="ltr" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@gmail.com" />
              </Field>
              {state === "error" && <p className="text-[14px] text-error">{error}</p>}
              <Button arrow className="group" disabled={state === "sending"}>
                {state === "sending" ? "שולחת…" : "שלחו לי קישור כניסה"}
              </Button>
            </form>
          )}
        </Card>
      </div>
    </div>
  );
}
