// Read-only access to the business mailbox (business@arli.co.il at Hostinger) over IMAP.
// Secrets: BUSINESS_MAIL_PASSWORD (required), BUSINESS_MAIL_USER (default business@arli.co.il),
// BUSINESS_MAIL_HOST (default imap.hostinger.com), BUSINESS_MAIL_PORT (default 993, TLS). Messages are never changed: every fetch uses
// BODY.PEEK, so nothing is even marked as read.
import PostalMime from "npm:postal-mime@2.7.6";

export const BUSINESS_MAIL_USER = Deno.env.get("BUSINESS_MAIL_USER") || "business@arli.co.il";
const HOST = Deno.env.get("BUSINESS_MAIL_HOST") || "imap.hostinger.com";
const PORT = Number(Deno.env.get("BUSINESS_MAIL_PORT")) || 993;
const PASSWORD = Deno.env.get("BUSINESS_MAIL_PASSWORD") ?? "";

export const businessMailConfigured = () => !!PASSWORD;

const enc = new TextEncoder();
const dec = new TextDecoder();

// One untagged or tagged response, with any {n} literals kept as raw bytes.
type Resp = { text: string; literals: Uint8Array[] };

class Imap {
  private buf = new Uint8Array(0);
  private seq = 0;
  private literalPlus = false;
  private constructor(private conn: Deno.TlsConn) {}

  static async open(): Promise<Imap> {
    if (!PASSWORD) throw new Error("תיבת המייל העסקית עוד לא מחוברת: חסר הסיקרט BUSINESS_MAIL_PASSWORD ב-Supabase.");
    const conn = await Deno.connectTls({ hostname: HOST, port: PORT });
    const c = new Imap(conn);
    await c.readResp(); // greeting
    const caps = await c.cmd("CAPABILITY");
    c.literalPlus = caps.some((r) => /\bLITERAL\+/i.test(r.text));
    try {
      await c.cmd(["LOGIN ", c.str(BUSINESS_MAIL_USER), " ", c.str(PASSWORD)]);
    } catch {
      c.close();
      throw new Error(`הכניסה לתיבה ${BUSINESS_MAIL_USER} נכשלה. כנראה הסיסמה בסיקרט BUSINESS_MAIL_PASSWORD לא נכונה.`);
    }
    return c;
  }

  close() { try { this.conn.close(); } catch { /* already closed */ } }

  // A string argument: quoted when plain ASCII, otherwise sent as a literal.
  str(s: string): string | Uint8Array {
    if (/^[\x20-\x7e]*$/.test(s) && s.length < 900) return `"${s.replace(/[\\"]/g, (m) => "\\" + m)}"`;
    return enc.encode(s);
  }

  private async fill(): Promise<void> {
    const chunk = new Uint8Array(64 * 1024);
    const n = await this.conn.read(chunk);
    if (n === null) throw new Error("החיבור לתיבת המייל נסגר באמצע");
    const next = new Uint8Array(this.buf.length + n);
    next.set(this.buf);
    next.set(chunk.subarray(0, n), this.buf.length);
    this.buf = next;
  }

  private async readLine(): Promise<string> {
    for (;;) {
      const i = this.buf.indexOf(10);
      if (i >= 0) {
        const line = dec.decode(this.buf.subarray(0, i)).replace(/\r$/, "");
        this.buf = this.buf.subarray(i + 1);
        return line;
      }
      await this.fill();
    }
  }

  private async readBytes(n: number): Promise<Uint8Array> {
    while (this.buf.length < n) await this.fill();
    const out = this.buf.slice(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  private async readResp(): Promise<Resp> {
    let text = "";
    const literals: Uint8Array[] = [];
    for (;;) {
      const line = await this.readLine();
      const m = line.match(/\{(\d+)\}$/);
      if (!m) return { text: text + line, literals };
      literals.push(await this.readBytes(Number(m[1])));
      text += line.slice(0, -m[0].length) + `\u0000${literals.length - 1}\u0000`;
    }
  }

  private async write(data: string | Uint8Array) {
    let b = typeof data === "string" ? enc.encode(data) : data;
    while (b.length) b = b.subarray(await this.conn.write(b));
  }

  // Sends a command and returns its untagged responses; throws on NO / BAD.
  async cmd(parts: string | (string | Uint8Array)[]): Promise<Resp[]> {
    const tag = `A${++this.seq}`;
    const list = typeof parts === "string" ? [parts] : parts;
    await this.write(`${tag} `);
    for (const p of list) {
      if (typeof p === "string") { await this.write(p); continue; }
      if (this.literalPlus) { await this.write(`{${p.length}+}\r\n`); await this.write(p); continue; }
      await this.write(`{${p.length}}\r\n`);
      for (;;) {
        const r = await this.readResp();
        if (r.text.startsWith("+")) break;
        if (r.text.startsWith(tag + " ")) throw new Error(`IMAP: ${r.text}`);
      }
      await this.write(p);
    }
    await this.write("\r\n");
    const out: Resp[] = [];
    for (;;) {
      const r = await this.readResp();
      if (r.text.startsWith(tag + " ")) {
        if (!/^\S+ OK/i.test(r.text)) throw new Error(`IMAP: ${r.text.slice(tag.length + 1, 300)}`);
        return out;
      }
      out.push(r);
    }
  }

  async select(folder: string): Promise<number> {
    const res = await this.cmd(["EXAMINE ", this.str(folder)]); // EXAMINE = read-only SELECT
    const v = res.map((r) => r.text.match(/UIDVALIDITY (\d+)/i)).find(Boolean);
    return v ? Number(v[1]) : 0;
  }
}

async function withImap<T>(fn: (c: Imap) => Promise<T>): Promise<T> {
  const c = await Imap.open();
  try {
    const out = await fn(c);
    await c.cmd("LOGOUT").catch(() => {});
    return out;
  } finally {
    c.close();
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function imapDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) throw new Error(`תאריך לא תקין: ${iso} (צריך YYYY-MM-DD)`);
  return `${d}-${MONTHS[m - 1]}-${y}`;
}

// Attachment file names from a BODYSTRUCTURE response (enough for a listing; the full read parses MIME).
function attachmentNames(bodystructure: string): string[] {
  const names = new Set<string>();
  for (const m of bodystructure.matchAll(/"(?:file)?name\*?" "([^"]+)"/gi)) {
    let n = m[1];
    try { n = decodeURIComponent(n.replace(/^[\w-]+''/, "")); } catch { /* keep as is */ }
    if (/=\?/.test(n)) n = decodeWords(n);
    if (/\.(pdf|png|jpe?g|webp|heic)$/i.test(n)) names.add(n);
  }
  return [...names];
}

// RFC 2047 encoded words (=?utf-8?B?...?=), as used in subjects and file names.
function decodeWords(s: string): string {
  return s.replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=\s*/gi, (_all, cs: string, kind: string, data: string) => {
    try {
      const bytes = kind.toLowerCase() === "b"
        ? Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0))
        : Uint8Array.from(data.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16))), (ch) => ch.charCodeAt(0));
      return new TextDecoder(cs).decode(bytes);
    } catch { return data; }
  });
}

export type BusinessMailSummary = {
  message_id: string; // "<folder>/<uid>", what read_business_mail_invoice takes
  key: string;        // stable dedup key, stored in expenses.gmail_message_id
  date: string; from: string; subject: string; attachments: string[];
};

const keyOf = (messageId: string | undefined, folder: string, validity: number, uid: number) =>
  messageId ? `biz:${messageId.replace(/^<|>$/g, "")}` : `biz:${folder}:${validity}:${uid}`;

// Search the mailbox. Words are OR-ed and matched anywhere in the message (Hebrew works too).
export async function searchBusinessMail(opts: {
  folder?: string; from?: string; words?: string[]; since?: string; before?: string; max?: number;
}): Promise<BusinessMailSummary[]> {
  const folder = opts.folder || "INBOX";
  const max = Math.min(Math.max(opts.max ?? 10, 1), 25);
  return await withImap(async (c) => {
    const validity = await c.select(folder);
    const crit: (string | Uint8Array)[] = [];
    if (opts.since) crit.push(` SINCE ${imapDate(opts.since)}`);
    if (opts.before) crit.push(` BEFORE ${imapDate(opts.before)}`);
    if (opts.from) crit.push(" FROM ", c.str(opts.from));
    const words = (opts.words ?? []).map((w) => w.trim()).filter(Boolean).slice(0, 8);
    if (words.length) {
      // OR takes two keys: OR a OR b c ...
      if (words.length > 1) crit.push(" " + "OR ".repeat(words.length - 1).trim());
      for (const w of words) crit.push(" TEXT ", c.str(w));
    }
    const anyUtf8 = crit.some((p) => typeof p !== "string");
    const res = await c.cmd(["UID SEARCH", anyUtf8 ? " CHARSET UTF-8" : "", crit.length ? "" : " ALL", ...crit]);
    const uids = res.flatMap((r) => r.text.match(/^\* SEARCH(.*)$/i)?.[1].trim().split(/\s+/).filter(Boolean).map(Number) ?? []);
    const pick = uids.sort((a, b) => b - a).slice(0, max);
    if (!pick.length) return [];
    const fetched = await c.cmd(`UID FETCH ${pick.join(",")} (UID BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)])`);
    const out: BusinessMailSummary[] = [];
    for (const r of fetched) {
      const uid = Number(r.text.match(/\bUID (\d+)/i)?.[1]);
      if (!uid || !r.literals.length) continue;
      const header = await PostalMime.parse(r.literals[r.literals.length - 1]);
      out.push({
        message_id: `${folder}/${uid}`, key: keyOf(header.messageId, folder, validity, uid),
        date: header.date ?? "", subject: header.subject ?? "",
        from: header.from ? `${header.from.name ?? ""} <${header.from.address ?? ""}>`.trim() : "",
        attachments: attachmentNames(r.text),
      });
    }
    return out.sort((a, b) => Number(b.message_id.split("/").pop()) - Number(a.message_id.split("/").pop()));
  });
}

const isDoc = (name: string, mime: string) =>
  /^(application\/pdf|image\/)/.test(mime) || /\.(pdf|png|jpe?g|webp|heic)$/i.test(name);

// Many senders (Supabase/Stripe among them) label PDFs application/octet-stream: go by the file name.
function docMime(name: string, mime: string): string {
  if (/^(application\/pdf|image\/)/.test(mime)) return mime;
  if (/\.pdf$/i.test(name)) return "application/pdf";
  if (/\.png$/i.test(name)) return "image/png";
  if (/\.webp$/i.test(name)) return "image/webp";
  if (/\.heic$/i.test(name)) return "image/heic";
  return "image/jpeg";
}

export type BusinessMail = {
  key: string; date: string; from: string; subject: string; html: string; text: string;
  attachments: { filename: string; mimeType: string; content: Uint8Array }[];
};

// Fetch and parse one whole message, by the "<folder>/<uid>" id from searchBusinessMail.
export async function readBusinessMail(id: string): Promise<BusinessMail> {
  const slash = id.lastIndexOf("/");
  const folder = slash > 0 ? id.slice(0, slash) : "INBOX";
  const uid = Number(id.slice(slash + 1));
  if (!uid) throw new Error(`מזהה מייל לא תקין: ${id}`);
  return await withImap(async (c) => {
    const validity = await c.select(folder);
    const res = await c.cmd(`UID FETCH ${uid} (UID BODY.PEEK[])`);
    const raw = res.find((r) => r.literals.length)?.literals[0];
    if (!raw) throw new Error("המייל לא נמצא בתיבה (אולי נמחק או הועבר לתיקייה אחרת).");
    if (raw.length > 25 * 1024 * 1024) throw new Error("המייל גדול מדי לקריאה (מעל 25MB).");
    const m = await PostalMime.parse(raw);
    return {
      key: keyOf(m.messageId, folder, validity, uid), date: m.date ?? "", subject: m.subject ?? "",
      from: m.from ? `${m.from.name ?? ""} <${m.from.address ?? ""}>`.trim() : "",
      html: m.html ?? "", text: m.text ?? "",
      attachments: (m.attachments ?? [])
        .filter((a) => a.mimeType === "application/pdf" || (!!a.filename && isDoc(a.filename, a.mimeType)))
        .map((a) => ({
          filename: a.filename ?? "invoice.pdf",
          mimeType: docMime(a.filename ?? "", a.mimeType),
          content: typeof a.content === "string" ? enc.encode(a.content) : new Uint8Array(a.content as ArrayBuffer),
        })),
    };
  });
}
