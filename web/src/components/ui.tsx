// Small set of primitives in the aRLi style: pills, bezel cards, hairline inputs.
import {
  createContext, useCallback, useContext, useEffect, useRef, useState,
  type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes,
} from "react";
import { Icon, type IconName } from "./icons";

export function Button({ variant = "primary", arrow, className = "", children, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "quiet"; arrow?: boolean }) {
  // Every button answers the pointer: a colour step on hover and a small press on click.
  const base = "press inline-flex items-center justify-center gap-3 rounded-full font-semibold transition-[background-color,color,box-shadow,transform] duration-300 disabled:opacity-50 disabled:pointer-events-none cursor-pointer";
  const styles = {
    primary: `bg-pink text-on-pink hover:bg-pink-hover ${arrow ? "ps-6 pe-1.5 py-1.5" : "px-6 py-2.5"} text-[16px]`,
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

// A round icon-only button. The label is required: it is what a screen reader says, and the tooltip.
export function IconButton({ icon, label, tone = "mute", size = 36, className = "", ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string; tone?: "mute" | "ghost" | "pink"; size?: number }) {
  const tones = {
    mute: "text-mute hover:text-bone hover:bg-[var(--hover-veil)]",
    ghost: "text-bone shadow-[inset_0_0_0_1px_var(--line-2)] hover:bg-[var(--hover-veil)]",
    pink: "bg-pink text-on-pink hover:bg-pink-hover",
  }[tone];
  return (
    <button type="button" aria-label={label} title={label} style={{ width: size, height: size }}
      className={`press inline-grid shrink-0 place-items-center rounded-full transition-colors duration-300 cursor-pointer ${tones} ${className}`} {...rest}>
      <Icon name={icon} size={Math.round(size * 0.5)} />
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
// A select gets a chevron, so it never looks like a plain text field.
export const Select = ({ className = "", ...p }: SelectHTMLAttributes<HTMLSelectElement>) => (
  <span className={`relative block ${className}`}>
    <select {...p} className="field cursor-pointer pe-10" />
    <Icon name="chevronDown" size={18} className="pointer-events-none absolute top-1/2 end-3.5 -translate-y-1/2 text-mute" />
  </span>
);
export const Textarea = (p: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea rows={3} {...p} className={`field ${p.className ?? ""}`} />;

// Month filter as a list of named months: clearer than the browser's month input, which shows "---------" when empty.
export function MonthSelect({ value, onChange, allowAll = true, back = 12 }: { value: string; onChange: (v: string) => void; allowAll?: boolean; back?: number }) {
  const now = new Date();
  const months = Array.from({ length: back }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    return [`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, d.toLocaleDateString("he-IL", { month: "long", year: "numeric" })];
  });
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} aria-label="חודש">
      {allowAll && <option value="">כל החודשים</option>}
      {months.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
    </Select>
  );
}

// Segmented control for tabs and quick filters.
export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: [T, string][]; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex max-w-full gap-1 overflow-x-auto rounded-full p-1 shadow-[inset_0_0_0_1px_var(--line)] no-scrollbar">
      {options.map(([k, l]) => (
        <button key={k} type="button" role="tab" aria-selected={value === k} onClick={() => onChange(k)}
          className={`press whitespace-nowrap rounded-full px-3 py-1.5 text-[15px] font-medium transition-colors sm:px-4 duration-300 ${value === k ? "bg-[var(--ink-3)] text-bone shadow-[inset_0_0_0_1px_var(--line-2)]" : "text-mute hover:text-bone"}`}>{l}</button>
      ))}
    </div>
  );
}

export function Pill({ children, tone = "mute" }: { children: ReactNode; tone?: "mute" | "pink" }) {
  return (
    <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-[13px] font-medium ${tone === "pink" ? "bg-pink/15 text-pink-soft" : "text-mute shadow-[inset_0_0_0_1px_var(--line-2)]"}`}>
      {children}
    </span>
  );
}

// Dialog: centred on desktop, a sheet from the bottom on phones. Locks the page scroll and focuses the first field.
export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const back = document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => (box.current?.querySelector<HTMLElement>("input:not([type=hidden]),select,textarea,[data-autofocus]") ?? box.current)?.focus());
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; back?.focus?.(); };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[var(--scrim)] sm:items-center sm:p-4 animate-fade" onClick={onClose}>
      <div ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title}
        className="sheet w-full outline-none sm:max-w-lg" onClick={(e) => e.stopPropagation()}>
        <div className="bezel">
          <div className="core max-h-[88dvh] overflow-y-auto">
            <div className="mb-5 flex items-center justify-between gap-3">
              <h2 className="text-[24px] font-semibold leading-tight">{title}</h2>
              <IconButton icon="close" label="סגירה" onClick={onClose} />
            </div>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

// In-app confirmation in place of the browser's grey confirm() box.
type ConfirmOpts = { title: string; body?: string; yes?: string; no?: string };
const ConfirmCtx = createContext<(o: ConfirmOpts) => Promise<boolean>>(async () => false);
export const useConfirm = () => useContext(ConfirmCtx);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [ask, setAsk] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const confirm = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => setAsk({ ...o, resolve })), []);
  const done = useCallback((v: boolean) => { setAsk((a) => { a?.resolve(v); return null; }); }, []);
  const close = useCallback(() => done(false), [done]);
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Modal open={!!ask} onClose={close} title={ask?.title ?? ""}>
        {ask?.body && <p className="mb-6 text-mute">{ask.body}</p>}
        <div className="flex flex-wrap gap-3">
          <Button data-autofocus onClick={() => done(true)}>{ask?.yes ?? "כן, למחוק"}</Button>
          <Button variant="ghost" onClick={close}>{ask?.no ?? "ביטול"}</Button>
        </div>
      </Modal>
    </ConfirmCtx.Provider>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-10 text-center text-mute">{children}</div>;
}

// Skeleton: the shape of what is coming, instead of the word "loading".
export function Loading({ rows = 4 }: { rows?: number }) {
  return (
    <div role="status" aria-label="טוען" className="space-y-4 py-2">
      <div className="skeleton h-4 w-24" />
      <div className="skeleton h-10 w-[min(420px,80%)]" />
      <div className="bezel"><div className="core space-y-4">
        {Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton h-5" style={{ width: `${92 - i * 11}%` }} />)}
      </div></div>
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  return <div className="py-4 text-error text-[14px]">{(error as Error)?.message ?? "שגיאה"}</div>;
}

export const Num = ({ children, className = "" }: { children: ReactNode; className?: string }) => <bdi className={`num ${className}`}>{children}</bdi>;

// A project's tag (client / business / learning): a small mark with a coloured dot, not a section of its own.
const TAG_DOT: Record<string, string> = { client: "bg-pink", business: "bg-bone", learning: "bg-mute-2" };
export function Tag({ type, label }: { type: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-[13px] font-medium text-bone/85 shadow-[inset_0_0_0_1px_var(--line-2)]">
      <span className={`size-1.5 rounded-full ${TAG_DOT[type] ?? "bg-mute"}`} aria-hidden />{label}
    </span>
  );
}

// Search field with an icon, used at the top of lists.
export function SearchInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <span className="relative block w-full sm:w-72">
      <Icon name="search" size={18} className="pointer-events-none absolute top-1/2 start-3.5 -translate-y-1/2 text-mute" />
      <input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder}
        className="field" style={{ paddingInlineStart: 42, paddingBlock: 10 }} />
    </span>
  );
}

// Thin progress bar: how much of an agreed price has come in.
export function Progress({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--ink-3)]" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full rounded-full bg-pink transition-[width] duration-700" style={{ width: `${pct}%` }} />
    </div>
  );
}
