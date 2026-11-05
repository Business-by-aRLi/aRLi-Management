// All database reads and writes in one place, so screens stay simple.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { must, supabase } from "./supabase";

export type Partner = { id: string; name: string; email: string | null; user_id: string | null };
export type Project = {
  id: string; name: string; type: string; status: string; client_id: string | null;
  agreed_price: number | null; notes: string | null; started_on: string | null; closed_on: string | null; clients?: { name: string } | null;
};
export type Client = { id: string; name: string; contact_name: string | null; phone: string | null; email: string | null; notes: string | null; created_at: string };
export type Idea = { id: string; title: string; description: string | null; status: string; created_by_partner_id: string | null; created_at: string; partners?: { name: string } | null };
export type WorkPlan = { id: string; title: string; period_start: string | null; period_end: string | null; goals: string | null };
export type Financials = { project_id: string; name: string; type: string; status: string; income: number; expenses: number; profit: number; shares_percent_total: number };
export type Balance = { partner_id: string; name: string; entitled: number; held: number; net_position: number };
export type Expense = {
  id: string; spent_on: string; amount: number; description: string; category: string | null; reference: string | null;
  receipt_path: string | null; notes?: string | null; project_id: string | null; paid_by_partner_id: string | null;
  projects?: { name: string } | null; partners?: { name: string } | null;
};
export type Income = {
  id: string; received_on: string; amount: number; method: string | null; notes: string | null;
  reference: string | null; receipt_path: string | null; project_id: string | null; client_id?: string | null; received_by_partner_id: string | null;
  projects?: { name: string } | null; partners?: { name: string } | null;
};
export type Settlement = { id: string; settled_on: string; amount: number; from_partner_id: string; to_partner_id: string; notes: string | null };
export type Task = {
  id: string; title: string; description: string | null; status: string; due_on: string | null; start_on: string | null; priority: number;
  created_at: string; completed_at: string | null; work_plan_id: string | null; project_id: string | null; assignee_partner_id: string | null; projects?: { name: string } | null; partners?: { name: string } | null;
};
export type Meeting = { id: string; title: string; starts_at: string; ends_at: string | null; location: string | null; projects?: { name: string } | null };
export type TimeEntry = { id: string; project_id: string | null; work_date: string; minutes: number; kind: string; description: string | null; projects?: { name: string } | null; partners?: { name: string } | null };
export type Share = { project_id: string; partner_id: string; percent: number };
export type RecurringCost = { id: string; name: string; amount: number; frequency: string; active: boolean; paid_by_partner_id: string | null; project_id: string | null };

const q = <T,>(key: unknown[], fn: () => PromiseLike<{ data: unknown; error: { message: string } | null }>) =>
  useQuery<T>({ queryKey: key, queryFn: async () => must((await fn()) as { data: T; error: { message: string } | null }) });

export const usePartners = () => q<Partner[]>(["partners"], () => supabase.from("partners").select("id,name,email,user_id").order("name"));
export const useProjects = () => q<Project[]>(["projects"], () => supabase.from("projects").select("*,clients(name)").order("name"));
export const useClients = () => q<Client[]>(["clients"], () => supabase.from("clients").select("*").order("name"));
export const useFinancials = () => q<Financials[]>(["financials"], () => supabase.from("project_financials").select("*"));
export type PartnerSummary = { partner_id: string; name: string; invested: number; profit_share: number; due: number; received: number; balance: number; expected_profit_share: number };
export type BusinessSummary = { income: number; project_expenses: number; general_expenses: number; profit: number; agreed_total: number; outstanding: number; expected_profit: number };
export const usePartnerSummary = () => q<PartnerSummary[]>(["balances", "partners"], () => supabase.from("partner_summary").select("*"));
export const useBusinessSummary = () => q<BusinessSummary>(["balances", "business"], () => supabase.from("business_summary").select("*").single());
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
export const useIdeas = () => q<Idea[]>(["ideas"], () => supabase.from("ideas").select("*,partners(name)").order("created_at", { ascending: false }));
export const useWorkPlans = () => q<WorkPlan[]>(["work_plans"], () => supabase.from("work_plans").select("*").order("period_start", { ascending: false, nullsFirst: false }));
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

export async function deleteReceipt(path: string) {
  await supabase.storage.from("receipts").remove([path]);
}

// What the parse-document function read from an uploaded invoice / receipt. Every field may be missing.
export type ParsedDocument = {
  is_financial_document: boolean; kind: "expense" | "income"; confidence: "high" | "medium" | "low";
  counterparty?: string; amount?: number; currency: string; date?: string; invoice_number?: string;
  description?: string; category?: string; project_id: string | null; payment_method?: string; note?: string;
  duplicates: { table: string; id: string; date: string; amount: number }[];
};

export async function parseDocument(path: string): Promise<ParsedDocument> {
  const { data, error } = await supabase.functions.invoke("parse-document", { body: { path } });
  if (error) {
    // The function answers errors as { error: "..." } in Hebrew; show that when we have it.
    const body = await (error as { context?: Response }).context?.json?.().catch(() => null);
    throw new Error(body?.error ?? "לא הצלחתי לקרוא את המסמך. אפשר למלא ידנית.");
  }
  return data as ParsedDocument;
}
