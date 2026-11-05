// Shared Gemini helpers for edge functions.
const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY")!;
export const GEMINI_MODELS = [Deno.env.get("GEMINI_MODEL") ?? "gemini-flash-latest", "gemini-2.5-flash"];

// Calls generateContent, falling back to the next model only when a model name is unknown (404).
// deno-lint-ignore no-explicit-any
export async function gemini(body: any): Promise<any> {
  let lastErr = "";
  for (const model of GEMINI_MODELS) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
      body: JSON.stringify(body),
    });
    if (r.ok) return r.json();
    lastErr = `${model}: ${r.status} ${await r.text()}`;
    if (r.status !== 404) break;
  }
  throw new Error(lastErr);
}

// The model's answer text, without "thought" parts.
// deno-lint-ignore no-explicit-any
export const answerText = (res: any): string =>
  // deno-lint-ignore no-explicit-any
  (res.candidates?.[0]?.content?.parts ?? []).filter((p: any) => p.text && !p.thought).map((p: any) => p.text).join("");

export function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export const S = (type: string, description?: string, extra: Record<string, unknown> = {}) => ({ type, description, ...extra });
