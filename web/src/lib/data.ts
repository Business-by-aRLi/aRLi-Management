// All database reads and writes in one place, so screens stay simple.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { must, supabase } from "./supabase";

export type Partner = { id: string; name: string; email: string | null; user_id: string | null };
export type Project = {
  id: string; name: string; type: string; status: string; client_id: string | null;
  agreed_price: number | null; notes: string | null; clients?: { name: string } | null;
};
export type Financials = { project_id: string; name: string; type: string; status: string; income: number; expenses: number; profit: number; shares_percent_total: number };
export type Balance = { partner_id: string; name: string; entitled: number; held: number; net_position: number };
export type Expense = {
  id: string; spent_on: string; amount: number; description: string; category: string | null; reference: string | null;
  receipt_path: string | null; project_id: string | null; paid_by_partner_id: string | null;
  projects?: { name: string } | null; partners?: { name: string } | null;
};
export type Income = {
  id: string; received_on: string; amount: number; method: string | null; notes: string | null;
  project_id: string | null; received_by_partner_id: string | null;
  projects?: { name: string } | null; partners?: { name: string } | null;
};
export type Settlement = { id: string; settled_on: string; amount: number; from_partner_id: string; to_partner_id: string; notes: string | null };
export type Task = {
  id: string; title: string; description: string | null; status: string; due_on: string | null; priority: number;
  project_id: string | null; assignee_partner_id: string | null; projects?: { name: string } | null; partners?: { name: string } | null;
};
export type Meeting = { id: string; title: string; starts_at: string; ends_at: string | null; location: string | null; projects?: { name: string } | null };
export type TimeEntry = { id: string; work_date: string; minutes: number; kind: string; description: string | null; projects?: { name: string } | null; partners?: { name: string } | null };
export type Share = { project_id: string; partner_id: string; percent: number };
export type RecurringCost = { id: string; name: string; amount: number; frequency: string; active: boolean; paid_by_partner_id: string | null; project_id: string | null };

const q = <T,>(key: unknown[], fn: () => PromiseLike<{ data: unknown; error: { message: string } | null }>) =>
  useQuery<T>({ queryKey: key, queryFn: async () => must((await fn()) as { data: T; error: { message: string } | null }) });

export const usePartners = () => q<Partner[]>(["partners"], () => supabase.from("partners").select("id,name,email,user_id").order("name"));
export const useProjects = () => q<Project[]>(["projects"], () => supabase.from("projects").select("*,clients(name)").order("name"));
export const useFinancials = () => q<Financials[]>(["financials"], () => supabase.from("project_financials").select("*"));
export const useBalances = () => q<Balance[]>(["balances"], () => supabase.from("partner_balances").select("*"));
export const useShares = () => q<Share[]>(["shares"], () => supabase.from("project_profit_shares").select("*"));
export const useExpenses = () => q<Expense[]>(["expenses"], () =>
  supabase.from("expenses").select("*,projects(name),partners(name)").order("spent_on", { ascending: false }).limit(500));
export const useIncome = () => q<Income[]>(["income"], () =>
  supabase.from("income").select("*,projects(name),partners(name)").order("received_on", { ascending: false }).limit(500));
export const useSettlements = () => q<Settlement[]>(["settlements"], () =>
  supabase.from("settlements").select("*").order("settled_on", { ascending: false }));
export const useRecurring = () => q<RecurringCost[]>(["recurring"], () => supabase.from("recurring_costs").select("*").order("name"));
export const useTasks = () => q<Task[]>(["tasks"], () =>
  supabase.from("tasks").select("*,projects(name),partners(name)").order("due_on", { ascending: true, nullsFirst: false }));
export const useMeetings = (fromIso: string, toIso: string) => q<Meeting[]>(["meetings", fromIso, toIso], () =>
  supabase.from("meetings").select("*,projects(name)").gte("starts_at", fromIso).lte("starts_at", toIso).order("starts_at"));
export const useTime = () => q<TimeEntry[]>(["time"], () =>
  supabase.from("time_entries").select("*,projects(name),partners(name)").order("work_date", { ascending: false }).limit(500));

// Generic insert/update/delete that refreshes every list afterwards (money changes ripple into balances).
export function useSave(table: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, values }: { id?: string; values: Record<string, unknown> }) => {
      if (id) must(await supabase.from(table).update(values).eq("id", id));
      else must(await supabase.from(table).insert(values));
    },
    onSuccess: () => qc.invalidateQueries(),
  });
}

export function useRemove(table: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => { must(await supabase.from(table).delete().eq("id", id)); },
    onSuccess: () => qc.invalidateQueries(),
  });
}

export function useSaveShares() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (rows: Share[]) => { must(await supabase.from("project_profit_shares").upsert(rows)); },
    onSuccess: () => qc.invalidateQueries(),
  });
}

export async function receiptUrl(path: string) {
  const { data } = await supabase.storage.from("receipts").createSignedUrl(path, 60 * 10);
  return data?.signedUrl;
}

export async function uploadReceipt(file: File) {
  const ext = file.name.split(".").pop() ?? "jpg";
  const path = `${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}.${ext}`;
  must(await supabase.storage.from("receipts").upload(path, file, { contentType: file.type }));
  return path;
}
