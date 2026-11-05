import { createClient } from "@supabase/supabase-js";

// The publishable key is public by design. What each user can see is decided by RLS in the database.
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
);

// Throws on error so TanStack Query shows the error state instead of silently returning nothing.
export function must<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}
