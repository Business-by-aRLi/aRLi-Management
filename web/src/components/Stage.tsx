// The project lifecycle: בתכנון → בהקמה → בהטמעה → פעיל, and ארכיון at the side.
import { isArchived, PROJECT_STAGES, PROJECT_STATUS, stageIndex } from "../lib/format";

const FLOW = PROJECT_STAGES.slice(0, 4); // the archive is not a step forward

// Small: the stage name with four dots that fill up as the project moves on.
export function StageMini({ status }: { status: string }) {
  const at = stageIndex(status);
  const archived = isArchived(status);
  return (
    <span className="inline-flex items-center gap-2 text-[13px] font-medium text-mute" title={`שלב: ${PROJECT_STATUS[status] ?? status}`}>
      {!archived && (
        <span className="flex gap-1" aria-hidden>
          {FLOW.map(([k], i) => <span key={k} className={`h-1.5 w-3 rounded-full ${i <= at ? "bg-pink" : "bg-[var(--line-2)]"}`} />)}
        </span>
      )}
      <span className={at === 3 ? "text-pink-soft" : ""}>{PROJECT_STATUS[status] ?? status}</span>
    </span>
  );
}

// Large, clickable: move a project to another stage in one tap.
export function StageStepper({ status, onChange, disabled }: { status: string; onChange: (s: string) => void; disabled?: boolean }) {
  const at = stageIndex(status);
  const archived = isArchived(status);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <ol className="flex flex-1 basis-[420px] gap-1.5" aria-label="שלב הפרויקט">
        {FLOW.map(([k, v], i) => {
          const done = !archived && i <= at;
          return (
            <li key={k} className="flex-1">
              <button type="button" disabled={disabled} aria-current={!archived && i === at ? "step" : undefined} onClick={() => onChange(k)}
                className={`press group w-full text-start disabled:pointer-events-none`}>
                <span className={`block h-1.5 rounded-full transition-colors duration-500 ${done ? "bg-pink" : "bg-[var(--line-2)] group-hover:bg-[var(--mute-2)]"}`} />
                <span className={`mt-2 block text-[14px] font-medium ${!archived && i === at ? "text-bone" : "text-mute group-hover:text-bone"}`}>{v}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <button type="button" disabled={disabled} onClick={() => onChange(archived ? "active" : "archived")}
        className={`press rounded-full px-3.5 py-1.5 text-[14px] font-medium shadow-[inset_0_0_0_1px_var(--line-2)] ${archived ? "bg-[var(--ink-3)] text-bone" : "text-mute hover:text-bone"}`}>
        {archived ? "בארכיון · להחזיר" : "להעביר לארכיון"}
      </button>
    </div>
  );
}
