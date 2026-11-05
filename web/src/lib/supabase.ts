import { createClient } from "@supabase/supabase-js";

// "Remember me": with it, the session lives in localStorage and survives closing the browser.
// Without it, the session lives in sessionStorage and ends when the tab closes.
const REMEMBER_KEY = "arli-remember";
export const setRemember = (on: boolean) => {
  try { localStorage.setItem(REMEMBER_KEY, on ? "1" : "0"); } catch { /* private mode */ }
};
const remembered = () => {
  try { return localStorage.getItem(REMEMBER_KEY) !== "0"; } catch { return false; }
};
const store = () => (remembered() ? localStorage : sessionStorage);

const authStorage = {
  getItem: (k: string) => { try { return localStorage.getItem(k) ?? sessionStorage.getItem(k); } catch { return null; } },
  setItem: (k: string, v: string) => {
    try {
      store().setItem(k, v);
      (remembered() ? sessionStorage : localStorage).removeItem(k);
    } catch { /* ignore */ }
  },
  removeItem: (k: string) => { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch { /* ignore */ } },
};

// The publishable key is public by design. What each user can see is decided by RLS in the database.
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  { auth: { storage: authStorage, persistSession: true } },
);

// Throws on error so TanStack Query shows the error state instead of silently returning nothing.
export function must<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}
