// Light / dark / follow the device. The choice lives in this browser only (a per-device convenience);
// index.html applies it before the first paint so there is no flash of the wrong theme.
import { useEffect, useState } from "react";

export type ThemePref = "dark" | "light" | "system";
const KEY = "arli-theme";
const media = () => window.matchMedia?.("(prefers-color-scheme: light)");

function readPref(): ThemePref {
  try { const v = localStorage.getItem(KEY); return v === "light" || v === "system" ? v : "dark"; } catch { return "dark"; }
}
const resolve = (p: ThemePref) => (p === "system" ? (media()?.matches ? "light" : "dark") : p);

function apply(p: ThemePref, fade: boolean) {
  const root = document.documentElement;
  const theme = resolve(p);
  if (fade) { root.classList.add("theme-fade"); window.setTimeout(() => root.classList.remove("theme-fade"), 400); }
  root.dataset.theme = theme;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", theme);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "light" ? "#F7F4EF" : "#0C0B10");
}

export function useTheme() {
  const [pref, setPrefState] = useState<ThemePref>(readPref);
  const [resolved, setResolved] = useState(() => resolve(readPref()));
  useEffect(() => {
    apply(pref, false);
    setResolved(resolve(pref));
    if (pref !== "system") return;
    const m = media();
    const on = () => { apply("system", true); setResolved(resolve("system")); };
    m?.addEventListener("change", on);
    return () => m?.removeEventListener("change", on);
  }, [pref]);
  const setPref = (p: ThemePref) => {
    try { localStorage.setItem(KEY, p); } catch { /* private mode */ }
    apply(p, true);
    setPrefState(p);
  };
  return { pref, resolved, setPref, toggle: () => setPref(resolve(pref) === "light" ? "dark" : "light") };
}
