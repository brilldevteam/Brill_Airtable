import { AlertTriangle, PenLine } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * In-app replacements for window.prompt / window.confirm.
 *   const dialogs = useDialogs();
 *   const name = await dialogs.prompt({ title: "Rename base", defaultValue: base.name });
 *   if (await dialogs.confirm({ title: "Delete base?", message: "…", danger: true })) …
 */
interface PromptOptions {
  title: string;
  message?: string;
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmText?: string;
}
interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmText?: string;
  danger?: boolean;
}
interface Dialogs {
  prompt: (o: PromptOptions) => Promise<string | null>;
  confirm: (o: ConfirmOptions) => Promise<boolean>;
}

const Ctx = createContext<Dialogs | null>(null);

type Open =
  | { kind: "prompt"; o: PromptOptions; resolve: (v: string | null) => void }
  | { kind: "confirm"; o: ConfirmOptions; resolve: (v: boolean) => void };

export function DialogProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<Open | null>(null);
  const prompt = useCallback((o: PromptOptions) => new Promise<string | null>((resolve) => setOpen({ kind: "prompt", o, resolve })), []);
  const confirm = useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => setOpen({ kind: "confirm", o, resolve })), []);

  return (
    <Ctx.Provider value={{ prompt, confirm }}>
      {children}
      {open?.kind === "prompt" && (
        <PromptDialog o={open.o} done={(v) => { open.resolve(v); setOpen(null); }} />
      )}
      {open?.kind === "confirm" && (
        <ConfirmDialog o={open.o} done={(v) => { open.resolve(v); setOpen(null); }} />
      )}
    </Ctx.Provider>
  );
}

export function useDialogs(): Dialogs {
  const d = useContext(Ctx);
  if (!d) throw new Error("useDialogs must be used inside <DialogProvider>");
  return d;
}

function useEscape(onEscape: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onEscape();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onEscape]);
}

function PromptDialog({ o, done }: { o: PromptOptions; done: (v: string | null) => void }) {
  const [value, setValue] = useState(o.defaultValue ?? "");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.select(); }, []);
  useEscape(useCallback(() => done(null), [done]));
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && done(null)}>
      <form
        className="modal"
        role="dialog"
        aria-label={o.title}
        onSubmit={(e) => { e.preventDefault(); if (value.trim()) done(value.trim()); }}
      >
        <div className="modal-head">
          <div className="modal-icon"><PenLine size={18} /></div>
          <div>
            <h3>{o.title}</h3>
            {o.message && <p className="modal-sub">{o.message}</p>}
          </div>
        </div>
        <label>
          {o.label ?? "Name"}
          <input ref={ref} autoFocus value={value} placeholder={o.placeholder} onChange={(e) => setValue(e.target.value)} />
        </label>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => done(null)}>Cancel</button>
          <button className="btn primary" disabled={!value.trim()}>{o.confirmText ?? "Save"}</button>
        </div>
      </form>
    </div>
  );
}

function ConfirmDialog({ o, done }: { o: ConfirmOptions; done: (v: boolean) => void }) {
  useEscape(useCallback(() => done(false), [done]));
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && done(false)}>
      <div className="modal" role="alertdialog" aria-label={o.title}>
        <div className="modal-head">
          <div className={"modal-icon" + (o.danger ? " danger" : "")}><AlertTriangle size={18} /></div>
          <div>
            <h3>{o.title}</h3>
            {o.message && <p className="modal-sub">{o.message}</p>}
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => done(false)}>Cancel</button>
          <button type="button" autoFocus className={"btn " + (o.danger ? "danger-solid" : "primary")} onClick={() => done(true)}>
            {o.confirmText ?? "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}
