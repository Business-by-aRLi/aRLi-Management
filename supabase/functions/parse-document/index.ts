// Reads an uploaded invoice / receipt (image or PDF) and suggests an expense or income record.
//   POST { path: "<file in the receipts bucket>" }  (signed-in partner's JWT in Authorization)
// It never writes a record. The web app shows the suggestion for the partner to confirm or edit.
//
// The file is downloaded with the caller's own JWT, so storage RLS (is_partner) decides access:
// a signed-in user who is not a partner gets "not found" and nothing is read.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { answerText, b64, gemini, S } from "../_shared/gemini.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const MAX_BYTES = 15 * 1024 * 1024;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function mimeOf(path: string, given?: string | null): string {
  if (given && /^(application\/pdf|image\/)/.test(given)) return given;
  const ext = path.split(".").pop()?.toLowerCase();
  return ({ pdf: "application/pdf", png: "image/png", webp: "image/webp", heic: "image/heic", heif: "image/heif" } as Record<string, string>)[ext ?? ""] ?? "image/jpeg";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const auth = req.headers.get("Authorization");
  if (!auth) return json({ error: "צריך להתחבר" }, 401);
  const db = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });

  let path: string;
  try { ({ path } = await req.json()); } catch { return json({ error: "bad request" }, 400); }
  if (!path || typeof path !== "string") return json({ error: "missing path" }, 400);

  const file = await db.storage.from("receipts").download(path);
  if (file.error || !file.data) return json({ error: "לא מצאתי את הקובץ, או שאין הרשאה אליו" }, 404);
  const bytes = new Uint8Array(await file.data.arrayBuffer());
  if (bytes.length > MAX_BYTES) return json({ error: "הקובץ גדול מדי (מעל 15MB)" }, 413);
  const mime = mimeOf(path, file.data.type);

  // Context for the model: the real project list (to guess the project) and categories already in use.
  const [projects, cats] = await Promise.all([
    db.from("projects").select("id,name,type,status,clients(name)").neq("status", "closed"),
    db.from("expenses").select("category").not("category", "is", null).limit(500),
  ]);
  // deno-lint-ignore no-explicit-any
  const projectRows = (projects.data ?? []) as any[];
  const categories = [...new Set((cats.data ?? []).map((r) => r.category as string))].slice(0, 30);
  const projectLines = projectRows.map((p) => `- ${p.name} (${p.type}${p.clients?.name ? `, לקוח: ${p.clients.name}` : ""})`).join("\n");

  const schema = S("object", undefined, {
    properties: {
      is_financial_document: S("boolean", "האם זו חשבונית, קבלה, חשבון עסקה או אישור תשלום"),
      kind: S("string", "expense = העסק שילם לספק. income = העסק (aRLi, מירי או ריקי) הוציא את המסמך ללקוח או קיבל תשלום", { enum: ["expense", "income"] }),
      counterparty: S("string", "בהוצאה: שם הספק. בהכנסה: שם הלקוח"),
      amount: S("number", "הסכום הכולל לתשלום, כולל מע\"מ"),
      currency: S("string", "קוד מטבע: ILS, USD, EUR וכו'"),
      date: S("string", "תאריך המסמך YYYY-MM-DD"),
      invoice_number: S("string", "מספר החשבונית או הקבלה"),
      description: S("string", "על מה החיוב, בקצרה ובעברית, למשל: מנוי חודשי ל-Vercel"),
      category: S("string", "קטגוריה להוצאה. עדיף אחת מהקיימות"),
      project_name: S("string", "הפרויקט המתאים ביותר מתוך הרשימה, או ריק אם לא ברור או שזו הוצאה כללית של העסק"),
      payment_method: S("string", "בהכנסה: העברה, ביט, צ'ק, מזומן, כרטיס אשראי"),
      confidence: S("string", "כמה ברורים הנתונים", { enum: ["high", "medium", "low"] }),
      note: S("string", "הערה קצרה בעברית אם משהו לא ברור, אחרת ריק"),
    },
    required: ["is_financial_document", "kind", "confidence"],
  });

  const prompt = `זה מסמך שהועלה למערכת הניהול של aRLi, עסק של השותפות מירי וריקי.
חלצי ממנו את פרטי התנועה הכספית.
אם המסמך הוצא על ידי aRLi, מירי או ריקי ללקוח, זו הכנסה. אם ספק חייב את העסק, זו הוצאה.
הפרויקטים הפעילים:
${projectLines || "(אין)"}
קטגוריות שכבר בשימוש: ${categories.join(", ") || "(אין עדיין)"}
אל תמציאי נתונים. מה שלא מופיע במסמך, השאירי ריק.`;

  let extracted: Record<string, unknown>;
  try {
    const res = await gemini({
      contents: [{ role: "user", parts: [{ inlineData: { mimeType: mime, data: b64(bytes) } }, { text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0 },
    });
    extracted = JSON.parse(answerText(res));
  } catch (e) {
    console.error(e);
    return json({ error: "לא הצלחתי לקרוא את המסמך. אפשר למלא ידנית." }, 502);
  }

  const name = String(extracted.project_name ?? "").trim();
  const project = name ? projectRows.find((p) => p.name === name) ?? projectRows.find((p) => p.name.toLowerCase().includes(name.toLowerCase())) : null;

  // Possible duplicates: same invoice number, or same amount on the same date.
  const duplicates: { table: string; id: string; date: string; amount: number }[] = [];
  const amount = Number(extracted.amount);
  if (extracted.kind === "expense") {
    if (extracted.invoice_number) {
      const { data } = await db.from("expenses").select("id,spent_on,amount").eq("reference", String(extracted.invoice_number)).limit(3);
      data?.forEach((r) => duplicates.push({ table: "expenses", id: r.id, date: r.spent_on, amount: r.amount }));
    }
    if (amount > 0 && extracted.date && !duplicates.length) {
      const { data } = await db.from("expenses").select("id,spent_on,amount").eq("amount", amount).eq("spent_on", String(extracted.date)).limit(3);
      data?.forEach((r) => duplicates.push({ table: "expenses", id: r.id, date: r.spent_on, amount: r.amount }));
    }
  } else if (amount > 0 && extracted.date) {
    const { data } = await db.from("income").select("id,received_on,amount").eq("amount", amount).eq("received_on", String(extracted.date)).limit(3);
    data?.forEach((r) => duplicates.push({ table: "income", id: r.id, date: r.received_on, amount: r.amount }));
  }

  return json({
    ...extracted,
    currency: String(extracted.currency || "ILS").toUpperCase(),
    project_id: project?.id ?? null,
    duplicates,
  });
});
