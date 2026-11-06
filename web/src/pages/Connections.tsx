// Connections to outside providers, like the "connectors" screen of any SaaS. A key is pasted once,
// stored encrypted in the database (Supabase Vault) and never shown again; the app sees only its status.
import { useRef, useState } from "react";
import {
  useConnectorActions, useConnectors, useInfraSync, useInvoiceImports, useProviderResources, useSupabaseInvoiceUpload, type Connector,
} from "../lib/data";
import { dateTime } from "../lib/format";
import { Button, Card, Field, Input, Loading, Modal, PageTitle, Pill, useConfirm } from "../components/ui";

type Info = { name: string; gives: string; keyLabel: string; where: string; url: string; team?: boolean };
export const CONNECTORS: Record<string, Info> = {
  vercel: {
    name: "Vercel", gives: "עלות אחסון לכל פרויקט, כל בוקר, כולל 12 החודשים האחרונים. מנוי Pro עצמו משויך דרך \"עלות התוכנית של הצוות\".",
    keyLabel: "Access Token", where: "Account Settings › Tokens › Create", url: "https://vercel.com/account/settings/tokens", team: true,
  },
  anthropic: {
    name: "Claude API", gives: "עלות שימוש ב־Claude לכל Workspace. כדאי Workspace נפרד לכל פרויקט.",
    keyLabel: "Admin API key (sk-ant-admin…)", where: "Console › Settings › Admin keys", url: "https://console.anthropic.com/settings/admin-keys",
  },
  openai: {
    name: "OpenAI", gives: "עלות שימוש לכל פרויקט OpenAI.",
    keyLabel: "Admin key", where: "Settings › Organization › Admin keys", url: "https://platform.openai.com/settings/organization/admin-keys",
  },
  supabase: {
    name: "Supabase", gives: "נתוני שימוש לכל פרויקט (בקשות API). העלות לפי פרויקט נקראת מהחשבונית החודשית.",
    keyLabel: "Personal Access Token", where: "Account › Access Tokens › Generate", url: "https://supabase.com/dashboard/account/tokens",
  },
};

export default function Connections() {
  const connectors = useConnectors();
  const sync = useInfraSync();
  const [open, setOpen] = useState<string | null>(null);
  if (connectors.isLoading) return <Loading />;
  const byProvider = new Map((connectors.data ?? []).map((c) => [c.provider, c]));

  return (
    <div className="space-y-8">
      <PageTitle eyebrow="הגדרות" title="חיבורים"
        action={byProvider.size > 0 && <Button variant="ghost" disabled={sync.isPending} onClick={() => sync.mutate({ gmail: true, history: true })}>{sync.isPending ? "מסנכרנת…" : "סנכרון כל ההיסטוריה"}</Button>} />
      <p className="max-w-[640px] text-mute">
        מחברים ספק פעם אחת, ומעכשיו העלויות שלו נמשכות כל בוקר לכרטיס "תשתיות" בכל פרויקט. המפתח נשמר מוצפן ולא מוצג שוב.
      </p>
      {sync.data && (
        <p className="text-[14px] text-mute">{Object.values(sync.data.report).join(" · ") || "אין שירותים משויכים לסנכרון"}
          {!!sync.data.errors.length && <span className="block text-error">{sync.data.errors.join(" · ")}</span>}</p>
      )}
      {sync.error && <p className="text-[14px] text-error">{(sync.error as Error).message}</p>}

      <div className="grid gap-5 md:grid-cols-2">
        {Object.entries(CONNECTORS).map(([id, info]) => (
          <ConnectorCard key={id} id={id} info={info} conn={byProvider.get(id)} onConnect={() => setOpen(id)}>
            {id === "supabase" && <SupabaseInvoices />}
          </ConnectorCard>
        ))}
        <Card>
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-[22px] font-semibold">Google Cloud / Gemini</h2>
            <Pill>ידני</Pill>
          </div>
          <p className="mt-2 text-mute">גוגל חושפת עלויות רק דרך ייצוא חיובים ל־BigQuery. כל עוד Gemini בשכבה החינמית, רושמים ידנית בכרטיס הפרויקט.</p>
        </Card>
      </div>

      <Modal open={!!open} onClose={() => setOpen(null)} title={open ? `חיבור ${CONNECTORS[open].name}` : ""}>
        {open && <ConnectForm key={open} id={open} info={CONNECTORS[open]} conn={byProvider.get(open)} onDone={() => setOpen(null)} />}
      </Modal>
    </div>
  );
}

function ConnectorCard({ id, info, conn, onConnect, children }: { id: string; info: Info; conn?: Connector; onConnect: () => void; children?: React.ReactNode }) {
  const { remove } = useConnectorActions();
  const confirm = useConfirm();
  const [testing, setTesting] = useState(false);
  const test = useProviderResources(id, testing && !!conn);
  const status = !conn ? null : conn.check_ok === false ? "error" : conn.check_ok ? "ok" : "new";

  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[22px] font-semibold">{info.name}</h2>
        {!conn ? <Pill>לא מחובר</Pill> : status === "error" ? <span className="text-[14px] text-error">שגיאה בחיבור</span> : <Pill tone="pink">מחובר</Pill>}
      </div>
      <p className="mt-2 text-mute">{info.gives}</p>
      {conn && (
        <div className="mt-4 space-y-1 border-t border-[var(--line)] pt-3 text-[14px] text-mute">
          <div>מפתח <bdi dir="ltr">{conn.key_hint}</bdi>{conn.partners?.name ? ` · חוברה ע״י ${conn.partners.name}` : ""} · {dateTime(conn.connected_at)}</div>
          {conn.extra?.team_id && <div>Team <bdi dir="ltr">{conn.extra.team_id}</bdi></div>}
          {conn.checked_at && <div className={conn.check_ok === false ? "text-error" : ""}>בדיקה אחרונה {dateTime(conn.checked_at)}: {conn.check_message}</div>}
          {testing && test.isFetching && <div>בודקת…</div>}
          {testing && test.data && <div>החיבור עובד: נמצאו {test.data.length} פרויקטים.</div>}
          {testing && test.error && <div className="text-error">{(test.error as Error).message}</div>}
        </div>
      )}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button variant={conn ? "ghost" : "primary"} onClick={onConnect}>{conn ? "החלפת מפתח" : "חיבור"}</Button>
        {conn && <Button variant="quiet" disabled={test.isFetching} onClick={() => { setTesting(true); test.refetch(); }}>בדיקת חיבור</Button>}
        {conn && (
          <button type="button" className="ms-auto text-[14px] text-mute hover:text-error" disabled={remove.isPending} onClick={async () => {
            if (!(await confirm({ title: `לנתק את ${info.name}?`, body: "המפתח יימחק. העלויות שכבר נמשכו נשארות.", yes: "כן, לנתק" }))) return;
            remove.mutate(id);
          }}>ניתוק</button>
        )}
      </div>
      {children}
    </Card>
  );
}

// Supabase bills per organization but lists each project on the invoice: read from Gmail daily, or uploaded here.
function SupabaseInvoices() {
  const upload = useSupabaseInvoiceUpload();
  const imports = useInvoiceImports();
  const input = useRef<HTMLInputElement>(null);
  const last = upload.data;
  const mm = (m?: string | null) => (m ? `${m.slice(5, 7)}/${m.slice(0, 4)}` : "");
  return (
    <div className="mt-5 border-t border-[var(--line)] pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-[17px] font-semibold">חשבונית חודשית</h3>
        <Button variant="ghost" disabled={upload.isPending} onClick={() => input.current?.click()}>{upload.isPending ? "קוראת…" : "העלאת חשבונית"}</Button>
        <input ref={input} type="file" accept="application/pdf,image/*" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = ""; }} />
      </div>
      <p className="mt-1 text-[14px] text-mute">כל בוקר נבדק ה־Gmail המחובר לחשבוניות Supabase חדשות. אפשר גם להעלות PDF מ־Billing › Invoices.</p>
      {upload.error && <p className="mt-2 text-[14px] text-error">{(upload.error as Error).message}</p>}
      {last && (
        <p className="mt-2 text-[14px]">חשבונית {mm(last.month)}: נרשמה עלות ל־{last.matched} שירותים.
          {!!last.unmatched.length && <span className="block text-mute">לא שויכו: {last.unmatched.map((u) => `${u.name} ($${u.amount})`).join(", ")}. מוסיפים שירות Supabase לפרויקט המתאים ומעלים שוב.</span>}
        </p>
      )}
      {!!imports.data?.length && (
        <div className="mt-3 space-y-1 text-[13px] text-mute">
          {imports.data.map((i) => (
            <div key={i.source_key}>
              {mm(i.month)} · {i.source_key.startsWith("gmail:") ? "מ־Gmail" : "הועלתה"}
              {i.total != null && <> · <bdi>${Number(i.total)}</bdi></>}
              {" "}· {i.result?.matched ?? 0} שויכו{i.result?.unmatched?.length ? `, ${i.result.unmatched.length} לא שויכו` : ""}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ConnectForm({ id, info, conn, onDone }: { id: string; info: Info; conn?: Connector; onDone: () => void }) {
  const { save } = useConnectorActions();
  const [key, setKey] = useState("");
  const [team, setTeam] = useState(conn?.extra?.team_id ?? "");
  return (
    <form className="space-y-4" onSubmit={async (e) => {
      e.preventDefault();
      try {
        await save.mutateAsync({ provider: id, key: key.trim(), extra: info.team && team.trim() ? { team_id: team.trim() } : {} });
        onDone();
      } catch { /* shown below */ }
    }}>
      <p className="text-mute">
        יוצרים מפתח ב־<a href={info.url} target="_blank" rel="noreferrer" className="text-pink hover:text-pink-soft">{info.where}</a>, ומדביקים כאן.
      </p>
      <Field label={info.keyLabel}>
        <Input dir="ltr" type="password" autoComplete="off" required value={key} onChange={(e) => setKey(e.target.value)} placeholder={conn ? `מחליף את ${conn.key_hint}` : ""} />
      </Field>
      {info.team && (
        <Field label="Team ID (לא חובה)" hint="אם הפרויקטים ב־Vercel יושבים בצוות: Team Settings › General › Team ID">
          <Input dir="ltr" value={team} onChange={(e) => setTeam(e.target.value)} placeholder="team_…" />
        </Field>
      )}
      {save.error && <p className="text-[14px] text-error">{(save.error as Error).message}</p>}
      <div className="flex gap-3">
        <Button disabled={save.isPending || key.trim().length < 8}>{save.isPending ? "שומרת…" : "שמירה"}</Button>
        <Button type="button" variant="quiet" onClick={onDone}>ביטול</Button>
      </div>
    </form>
  );
}
