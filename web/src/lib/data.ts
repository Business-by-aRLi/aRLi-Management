// All database reads and writes in one place, so screens stay simple.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { must, supabase } from "./supabase";

export type Partner = { id: string; name: string; email: string | null; user_id: string | null };
export type Project = {
  id: string; name: string; type: string; status: string; client_id: string | null;
  agreed_price: number | null; notes: string | null; started_on: string | null; closed_on: string | null; delivered_on?: string | null; clients?: { name: string } | null;
};
export type Client = { id: string; name: string; contact_name: string | null; phone: string | null; email: string | null; notes: string | null; created_at: string };
export type Idea = { id: string; title: string; description: string | null; status: string; created_by_partner_id: string | null; created_at: string; partners?: { name: string } | null };
export type WorkPlan = { id: string; title: string; period_start: string | null; period_end: string | null; goals: string | null };
export type Financials = { project_id: string; name: string; type: string; status: string; income: number; expenses: number; profit: number; shares_percent_total: number; agreed_price: number | null; outstanding: number; expected_income: number; expected_profit: number };
export type Balance = { partner_id: string; name: string; entitled: number; held: number; net_position: number };
export type Expense = {
  id: string; spent_on: string; amount: number; description: string; vendor?: string | null; category: string | null; reference: string | null;
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
  created_at: string; completed_at: string | null; work_plan_id: string | null; project_id: string | null; assignee_partner_id: string | null; is_private: boolean; projects?: { name: string } | null; partners?: { name: string } | null;
};
export type MeetingKind = "meeting" | "focus" | "away";
export type Meeting = {
  id: string; title: string; starts_at: string; ends_at: string | null; location: string | null; projects?: { name: string } | null;
  project_id?: string | null; notes?: string | null; kind: MeetingKind; partner_ids: string[]; all_day: boolean;
  meet_link: string | null; want_meet?: boolean; task_id: string | null; google_event_id: string | null; needs_push?: boolean;
  is_private?: boolean; created_by_partner_id?: string | null;
};
// My personal Google events (with titles), and the other partner's personal and private events as "busy" (no title).
export type Busy = { partner_id: string; starts_at: string; ends_at: string; all_day: boolean; title: string | null; source: "google" | "private" };
export type GoogleConnection = { partner_id: string; email: string; connected_at: string; calendar: boolean };
export type SyncStatus = { calendar_id: string | null; last_pull: string | null; last_error: string | null; pending: number };
export type Slot = { starts_at: string; ends_at: string };
export type TimeEntry = { id: string; project_id: string | null; work_date: string; minutes: number; kind: string; description: string | null; projects?: { name: string } | null; partners?: { name: string } | null };
export type Share = { project_id: string; partner_id: string; percent: number; fixed_amount?: number | null };
// What each partner gets from a project, as calculated in the DB (percent or fixed amount).
export type PartnerShare = Share & { amount: number; expected_amount: number };
export type RecurringCost = { id: string; name: string; amount: number; frequency: string; active: boolean; paid_by_partner_id: string | null; project_id: string | null };

const q = <T,>(key: unknown[], fn: () => PromiseLike<{ data: unknown; error: { message: string } | null }>) =>
  useQuery<T>({ queryKey: key, queryFn: async () => must((await fn()) as { data: T; error: { message: string } | null }) });

export const usePartners = () => q<Partner[]>(["partners"], () => supabase.from("partners").select("id,name,email,user_id").order("name"));
export const useProjects = () => q<Project[]>(["projects"], () => supabase.from("projects").select("*,clients(name)").order("name"));
export const useClients = () => q<Client[]>(["clients"], () => supabase.from("clients").select("*").order("name"));
export const useFinancials = () => q<Financials[]>(["financials"], () => supabase.from("project_financials").select("*"));
export type PartnerSummary = { partner_id: string; name: string; invested: number; profit_share: number; due: number; received: number; balance: number; expected_profit_share: number; received_from_clients: number; transfers_net: number };
export type BusinessSummary = { income: number; project_expenses: number; general_expenses: number; profit: number; agreed_total: number; outstanding: number; expected_profit: number };
export type ExpenseSettlement = { partner_id: string; name: string; paid: number; her_half: number; balance: number };
export const useExpenseSettlement = () => q<ExpenseSettlement[]>(["balances", "expenses-split"], () => supabase.from("expense_settlement").select("*"));
export const usePartnerSummary = () => q<PartnerSummary[]>(["balances", "partners"], () => supabase.from("partner_summary").select("*"));
export const useBusinessSummary = () => q<BusinessSummary>(["balances", "business"], () => supabase.from("business_summary").select("*").single());
export const useBalances = () => q<Balance[]>(["balances"], () => supabase.from("partner_balances").select("*"));
export const usePartnerShares = () => q<PartnerShare[]>(["shares", "amounts"], () => supabase.from("project_partner_shares").select("*"));
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
export const useBusy = (fromIso: string, toIso: string) => q<Busy[]>(["busy", fromIso, toIso], () =>
  supabase.from("calendar_busy").select("*").lt("starts_at", toIso).gt("ends_at", fromIso).order("starts_at"));
export const useGoogleConnections = () => q<GoogleConnection[]>(["google"], () => supabase.from("google_connections").select("*"));
export const useSyncStatus = () => useQuery<SyncStatus | null>({
  queryKey: ["sync-status"], refetchInterval: 60_000,
  queryFn: async () => { const { data } = await supabase.from("calendar_sync_status").select("*").maybeSingle(); return (data as SyncStatus) ?? null; },
});
export async function findFreeSlots(opts: { from?: string; days?: number; minutes?: number; partners?: string[] }): Promise<Slot[]> {
  return must(await supabase.rpc("find_free_slots", {
    p_from: opts.from ?? null, p_days: opts.days ?? 7, p_minutes: opts.minutes ?? 60, p_partners: opts.partners ?? [],
  })) as Slot[];
}

export const useIdeas = () => q<Idea[]>(["ideas"], () => supabase.from("ideas").select("*,partners(name)").order("created_at", { ascending: false }));
export const useWorkPlans = () => q<WorkPlan[]>(["work_plans"], () => supabase.from("work_plans").select("*").order("period_start", { ascending: false, nullsFirst: false }));
export type Ritual = {
  id: string; key: string; title: string; description: string | null; cadence: "daily" | "weekly" | "monthly" | "quarterly" | "yearly";
  weekday: number | null; month: number | null; at_time: string; lead_days: number; duration: string | null; source: string | null;
  active: boolean; sort: number; last_done_on: string | null; next_on: string | null;
};
export type Principle = { id: string; text: string; theme: string; why: string | null; ritual_key: string | null; favorite: boolean; active: boolean };
export const useRituals = () => q<Ritual[]>(["rituals"], () => supabase.from("ritual_schedule").select("*").order("sort"));
export const usePrinciples = () => q<Principle[]>(["principles"], () => supabase.from("principles").select("*").order("created_at"));
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

export type InfraService = {
  id: string; project_id: string; provider: string; name: string; plan: string | null; resource_ref: string | null;
  monthly_cost: number; currency: "USD" | "ILS"; share_percent: number; renews_on: string | null; active: boolean;
  notes: string | null; usage_note: string | null; usage_synced_at: string | null; created_at: string;
  // Latest usage with no price attached (Supabase API requests, last 7 days).
  usage: { item: string; qty: number; unit: string }[] | null;
};
// One line item of a month's cost, as the provider reports it.
export type UsageItem = { item: string; qty: number; unit: string; cost: number };
export type InfraCost = { id: string; service_id: string; month: string; amount: number; source: string; usage_note: string | null;
  synced_at: string | null; breakdown: UsageItem[] | null };
export type InfraMonthly = { project_id: string; month: string; currency: "USD" | "ILS"; amount: number; has_actual: boolean };
export type InfraSyncLast = { at: string; report: Record<string, string>; errors: string[] } | null;
export const useInfraServices = () => q<InfraService[]>(["infra", "services"], () => supabase.from("infra_services").select("*").order("created_at"));
export const useInfraCosts = () => q<InfraCost[]>(["infra", "costs"], () => supabase.from("infra_costs").select("*").order("month", { ascending: false }));
export const useInfraMonthly = () => q<InfraMonthly[]>(["infra", "monthly"], () => supabase.from("project_infra_monthly").select("*").order("month"));
export const useInfraSyncLast = () => q<InfraSyncLast>(["infra", "last"], () => supabase.rpc("infra_sync_last"));

export function useInfraSync() {
  const qc = useQueryClient();
  return useMutation({
    // gmail: also look for new Supabase invoices in the connected mailboxes (the daily run always does).
    // full: go back 12 months (history) instead of the last two.
    // history: also look a year back for Supabase invoices (a run reads a few; the next continues).
    mutationFn: async (opts?: { gmail?: boolean; full?: boolean; history?: boolean }) => {
      const { data, error } = await supabase.functions.invoke("infra-sync", { body: { gmail: !!opts?.gmail, full: !!opts?.full, history: !!opts?.history } });
      if (error) throw new Error(error.message);
      return data as { ok: boolean; report: Record<string, string>; errors: string[] };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["infra"] }),
  });
}

export type Connector = {
  provider: string; key_hint: string | null; extra: Record<string, string>; connected_at: string;
  checked_at: string | null; check_ok: boolean | null; check_message: string | null; partners?: { name: string } | null;
};
export type ProviderResource = { id: string; name: string };
export const useConnectors = () => q<Connector[]>(["infra", "connectors"], () =>
  supabase.from("infra_connectors").select("provider,key_hint,extra,connected_at,checked_at,check_ok,check_message,partners:connected_by(name)"));

// Lists the provider's projects / workspaces through the sync function (also tests the key).
export function useProviderResources(provider: string, enabled: boolean) {
  return useQuery<ProviderResource[]>({
    queryKey: ["infra", "resources", provider],
    enabled,
    staleTime: 5 * 60 * 1000,
    retry: false,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("infra-sync", { body: { action: "resources", provider } });
      if (error) throw new Error(error.message);
      if (!data?.ok) throw new Error(data?.error ?? "החיבור נכשל");
      return data.resources as ProviderResource[];
    },
  });
}

export type InvoiceImport = { source_key: string; month: string | null; total: number | null; currency: string | null; imported_at: string;
  result: { matched?: number; unmatched?: { name: string; amount: number }[]; skipped?: string } | null };
export const useInvoiceImports = () => q<InvoiceImport[]>(["infra", "invoices"], () =>
  supabase.from("infra_invoice_imports").select("*").not("month", "is", null).order("imported_at", { ascending: false }).limit(5));

// Uploads a Supabase invoice and has the sync function file each project's amount.
export function useSupabaseInvoiceUpload() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const safe = file.name.replace(/[^\w.\-]+/g, "_").slice(-80) || "invoice.pdf";
      const path = `infra/supabase/${Date.now()}-${safe}`;
      must(await supabase.storage.from("receipts").upload(path, file, { contentType: file.type }));
      const { data, error } = await supabase.functions.invoke("infra-sync", { body: { action: "supabase_invoice", path } });
      if (error) throw new Error(error.message);
      if (!data?.ok) throw new Error(data?.error ?? "קריאת החשבונית נכשלה");
      return data as { month: string; matched: number; unmatched: { name: string; amount: number }[] };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["infra"] }),
  });
}

export function useConnectorActions() {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: ["infra"] });
  return {
    save: useMutation({
      mutationFn: async (v: { provider: string; key: string; extra: Record<string, string> }) =>
        must(await supabase.rpc("connector_save", { p_provider: v.provider, p_key: v.key, p_extra: v.extra })),
      onSuccess: done,
    }),
    remove: useMutation({
      mutationFn: async (provider: string) => must(await supabase.rpc("connector_remove", { p_provider: provider })),
      onSuccess: done,
    }),
  };
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

// ---------- leads and quotes ----------
export type Lead = {
  id: string; name: string; company: string | null; phone: string | null; email: string | null; source: string | null;
  stage: string; estimated_value: number | null; next_follow_up_on: string | null; follow_up_note: string | null;
  owner_partner_id: string | null; client_id: string | null; project_id: string | null; lost_reason: string | null;
  notes: string | null; stage_changed_at: string; created_at: string; partners?: { name: string } | null;
};
export type LeadActivity = { id: string; lead_id: string; kind: string; body: string; partner_id: string | null; created_at: string; partners?: { name: string } | null };
export type QuoteSection = { title: string; body: string };
export type QuoteItem = { id?: string; description: string; details: string | null; quantity: number; unit_price: number; recurring: boolean; sort_order?: number };
export type Quote = {
  id: string; kind: "document" | "portal"; portal_template: string | null; submitted_at: string | null; meeting_id: string | null; number: string; lead_id: string | null; client_id: string | null; project_id: string | null;
  recipient_name: string | null; title: string; intro: string | null; sections: QuoteSection[]; status: string;
  issued_on: string; valid_until: string; discount_type: "amount" | "percent"; discount_value: number; include_vat: boolean; vat_rate: number;
  subtotal: number; total: number; payment_terms: string | null; timeline: string | null; notes: string | null; public_token: string;
  sent_at: string | null; sent_via: string | null; viewed_at: string | null; view_count: number; responded_at: string | null;
  signer_name: string | null; response_note: string | null; created_at: string;
  leads?: { name: string; company: string | null; phone: string | null; email: string | null } | null;
  clients?: { name: string } | null; projects?: { name: string } | null;
};
export const useLeads = () => q<Lead[]>(["leads"], () => supabase.from("leads").select("*,partners(name)").order("created_at", { ascending: false }));
export const useLeadActivities = (leadId: string) => q<LeadActivity[]>(["lead_activities", leadId], () =>
  supabase.from("lead_activities").select("*,partners(name)").eq("lead_id", leadId).order("created_at", { ascending: false }));
export const useQuotes = () => q<Quote[]>(["quotes"], () =>
  supabase.from("quotes").select("*,leads(name,company,phone,email),clients(name),projects(name)").order("created_at", { ascending: false }));
export const useQuoteItems = (quoteId: string | undefined) => useQuery<QuoteItem[]>({
  queryKey: ["quote_items", quoteId], enabled: !!quoteId,
  queryFn: async () => must(await supabase.from("quote_items").select("*").eq("quote_id", quoteId!).order("sort_order")) as QuoteItem[],
});

// Saves a quote and replaces its items in one go; returns the quote id.
export function useSaveQuote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, values, items }: { id?: string; values: Record<string, unknown>; items: QuoteItem[] }) => {
      let quoteId = id;
      if (quoteId) must(await supabase.from("quotes").update(values).eq("id", quoteId));
      else quoteId = (must(await supabase.from("quotes").insert(values).select("id").single()) as { id: string }).id;
      must(await supabase.from("quote_items").delete().eq("quote_id", quoteId));
      const rows = items.filter((i) => i.description.trim()).map((i, n) => ({
        quote_id: quoteId, description: i.description.trim(), details: i.details?.trim() || null,
        quantity: Number(i.quantity) || 0, unit_price: Number(i.unit_price) || 0, recurring: i.recurring, sort_order: n,
      }));
      if (rows.length) must(await supabase.from("quote_items").insert(rows));
      return quoteId!;
    },
    onSuccess: () => qc.invalidateQueries(),
  });
}

export type PublicQuote = Omit<Quote, "id" | "lead_id" | "client_id" | "project_id" | "notes" | "public_token" | "sent_at" | "sent_via" | "viewed_at" | "view_count" | "response_note" | "created_at" | "leads" | "clients" | "projects"> & {
  expired: boolean; items: QuoteItem[];
};
export async function getPublicQuote(token: string, track: boolean) {
  return must(await supabase.rpc("get_public_quote", { p_token: token, p_track: track })) as PublicQuote | null;
}
export async function respondToQuote(token: string, approve: boolean, name: string, note: string) {
  return must(await supabase.rpc("respond_to_quote", { p_token: token, p_approve: approve, p_name: name, p_note: note || null })) as string;
}
export const quoteUrl = (q: { kind: string; public_token: string }, portalToken?: string | null) =>
  q.kind === "portal" ? `${window.location.origin}/proposal/${portalToken ?? q.public_token}` : `${window.location.origin}/q/${q.public_token}`;

// The interactive portal: its link, every time it was opened, and what happened in each visit.
export type ProposalLink = { id: string; token: string; client_name: string; template: string | null; quote_id: string; is_active: boolean; admin_key: string };
export type ProposalSession = { id: string; link_id: string; started_at: string; last_seen_at: string | null; locale: string | null; user_agent: string | null; completed_at: string | null; recommended_track: string | null };
export type ProposalEvent = { id: string; session_id: string; type: string; payload: Record<string, unknown> | null; created_at: string };
export type Proposal = { link: ProposalLink | null; sessions: ProposalSession[]; events: ProposalEvent[] };
export const useProposal = (quoteId: string | undefined, enabled = true) => useQuery<Proposal>({
  queryKey: ["proposal", quoteId], enabled: !!quoteId && enabled, refetchInterval: 60_000,
  queryFn: async () => {
    const link = must(await supabase.from("proposal_links").select("*").eq("quote_id", quoteId!).maybeSingle()) as ProposalLink | null;
    if (!link) return { link: null, sessions: [], events: [] };
    const sessions = must(await supabase.from("proposal_sessions").select("*").eq("link_id", link.id).order("started_at", { ascending: false })) as ProposalSession[];
    const events = sessions.length
      ? must(await supabase.from("proposal_events").select("*").in("session_id", sessions.map((x) => x.id)).order("created_at")) as ProposalEvent[]
      : [];
    return { link, sessions, events };
  },
});
export const useProposalLinks = () => q<ProposalLink[]>(["proposal_links"], () => supabase.from("proposal_links").select("*"));
