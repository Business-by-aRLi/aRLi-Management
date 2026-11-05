// Pick a client from the list, or type a new one. The new client is created only on save (see resolveClient).
import { useClients } from "../lib/data";
import { must, supabase } from "../lib/supabase";
import { Input, Select } from "./ui";

export type ClientChoice = { id: string; newName: string }; // id "" = none, "new" = create newName

export function ClientPicker({ value, onChange }: { value: ClientChoice; onChange: (v: ClientChoice) => void }) {
  const clients = useClients();
  return (
    <div className="grid gap-2">
      <Select aria-label="לקוח" value={value.id} onChange={(e) => onChange({ ...value, id: e.target.value })}>
        <option value="">בלי לקוח</option>
        {clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        <option value="new">+ לקוח חדש…</option>
      </Select>
      {value.id === "new" && (
        <Input autoFocus required placeholder="שם הלקוח" value={value.newName} onChange={(e) => onChange({ ...value, newName: e.target.value })} />
      )}
    </div>
  );
}

// Turns the picker's value into a client id, creating the client when it is new (or reusing one with the same name).
export async function resolveClient(v: ClientChoice): Promise<string | null> {
  if (v.id !== "new") return v.id || null;
  const name = v.newName.trim();
  if (!name) return null;
  const found = must(await supabase.from("clients").select("id").ilike("name", name).maybeSingle()) as { id: string } | null;
  return found?.id ?? (must(await supabase.from("clients").insert({ name }).select("id").single()) as { id: string }).id;
}
