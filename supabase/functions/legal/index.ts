// Public privacy policy and terms pages, required by Google's OAuth consent screen
// for the Telegram bot's Gmail connection.
//   GET /functions/v1/legal/privacy
//   GET /functions/v1/legal/terms
const PRIVACY = `aRLi Management - Privacy Policy

aRLi Management is an internal tool used only by the two partners of the aRLi business (Miri and Riki).

Gmail access: when a partner connects her Gmail account, the tool gets read-only access (gmail.readonly). It reads emails only when that partner asks the Telegram bot to find invoices. From those emails it saves the invoice file and the invoice details (vendor, amount, date, invoice number) to the business's private database, and only after the partner confirms. Other email content is not stored.

Data is stored in the business's private Supabase project. It is not sold, shared with third parties or used for advertising. Invoice files and email text are sent to Google Gemini only to extract the invoice details.

Google API use complies with the Google API Services User Data Policy, including the Limited Use requirements.

To remove access, tell the bot "disconnect Gmail" or remove it at https://myaccount.google.com/permissions. Contact: the aRLi partners.`;

const TERMS = `aRLi Management - Terms of Service

aRLi Management is a private internal tool for the partners of the aRLi business only. It is provided as is, with no warranty. Access is limited to the business partners, and each partner may disconnect her Google account at any time. Contact: the aRLi partners.`;

Deno.serve((req) => {
  const path = new URL(req.url).pathname;
  const body = path.endsWith("/terms") ? TERMS : PRIVACY;
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
});
