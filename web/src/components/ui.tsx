// Small set of primitives in the aRLi style: pills, bezel cards, hairline inputs.
import { useEffect, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes } from "react";

export function Button({ variant = "primary", arrow, className = "", children, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "quiet"; arrow?: boolean }) {
  const base = "inline-flex items-center gap-3 rounded-full font-semibold transition-colors duration-300 disabled:opacity-50 cursor-pointer";
  const styles = {
    primary: `bg-pink text-ink hover:bg-pink-hover ${arrow ? "ps-6 pe-1.5 py-1.5" : "px-6 py-2.5"} text-[16px]`,
    ghost: "text-bone px-6 py-2.5 shadow-[inset_0_0_0_1px_var(--line-2)] hover:bg-[var(--hover-veil)] text-[16px]",
    quiet: "text-mute hover:text-bone px-3 py-1.5 text-[15px] font-medium",
  }[variant];
  return (
    <button className={`${base} ${styles} ${className}`} {...rest}>
      {children}
      {arrow && (
        <span className="grid size-9 place-items-center rounded-full bg-[var(--on-pink-veil)] transition-transform duration-500 group-hover:-translate-x-1" aria-hidden>←</span>
      )}
    </button>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`bezel ${className}`}><div className="core">{children}</div></div>;
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="text-pink text-[15px] font-medium tracking-[0.01em]">{children}</div>;
}

export function PageTitle({ eyebrow, title, action }: { eyebrow: string; title: ReactNode; action?: ReactNode }) {
  return (
    <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        <Eyebrow>{eyebrow}</Eyebrow>
        <h1 className="mt-1 text-[clamp(30px,3.7vw,52px)] font-semibold leading-[1.1] tracking-[-0.015em]">{title}</h1>
      </div>
      {action}
    </header>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[15px] font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[13px] text-mute-2">{hint}</span>}
    </label>
  );
}

export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={`field ${p.className ?? ""}`} />;
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={`field ${p.className ?? ""}`} />;
export const Textarea = (p: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea rows={3} {...p} className={`field ${p.className ?? ""}`} />;

export function Pill({ children, tone = "mute" }: { children: ReactNode; tone?: "mute" | "pink" }) {
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-[13px] font-medium ${tone === "pink" ? "bg-pink/15 text-pink-soft" : "text-mute shadow-[inset_0_0_0_1px_var(--line-2)]"}`}>
      {children}
    </span>
  );
}

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <Card>
          <div className="mb-5 flex items-center justify-between">
            <h2 className="text-[24px] font-semibold">{title}</h2>
            <button onClick={onClose} className="text-mute hover:text-bone text-2xl leading-none" aria-label="סגירה">×</button>
          </div>
          {children}
        </Card>
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-10 text-center text-mute">{children}</div>;
}

export function Loading() {
  return <div className="py-10 text-center text-mute-2">טוען…</div>;
}

export function ErrorNote({ error }: { error: unknown }) {
  return <div className="py-4 text-error text-[14px]">{(error as Error)?.message ?? "שגיאה"}</div>;
}

export const Num = ({ children, className = "" }: { children: ReactNode; className?: string }) => <bdi className={`num ${className}`}>{children}</bdi>;
