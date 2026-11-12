import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, FileQuestion } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { api, type PublicFormField } from "../api";
import { BASE_COLORS } from "../colors";
import { LogoMark } from "../components/AppBar";
import { FormInput, type UploadedFile } from "../components/FormInput";

/** Unanswered? (A required checkbox must be ticked.) */
const isEmpty = (_f: PublicFormField, v: unknown) =>
  v === undefined || v === null || v === "" || v === false || (Array.isArray(v) && v.length === 0);

/** The public form anyone with the link can fill in. */
export function PublicFormPage() {
  const { token } = useParams();
  const q = useQuery({ queryKey: ["publicForm", token], queryFn: () => api.publicForm(token!), retry: false });
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  if (q.isLoading) return <div className="center"><div className="spinner" /></div>;
  if (q.isError || !q.data) {
    return (
      <div className="pf-page">
        <div className="pf-card pf-message">
          <FileQuestion size={34} />
          <h2>Form not available</h2>
          <p className="muted">{(q.error as Error)?.message ?? "This link isn't active."}</p>
        </div>
      </div>
    );
  }
  const { form, base } = q.data;
  const accent = BASE_COLORS[base.color] ?? BASE_COLORS.purple;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const miss = new Set(form.fields.filter((f) => f.required && isEmpty(f, values[f.id])).map((f) => f.id));
    setMissing(miss);
    const uploading = form.fields.some((f) => f.type === "attachment" && ((values[f.id] as UploadedFile[]) ?? []).some((x) => !x.id && !x.error));
    if (uploading) return setError("Please wait for your files to finish uploading.");
    if (miss.size) {
      document.getElementById(`q-${[...miss][0]}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      return setError("Please answer the required questions.");
    }
    const cells: Record<string, unknown> = {};
    for (const f of form.fields) {
      const v = values[f.id];
      if (isEmpty(f, v)) continue;
      if (f.type === "attachment") cells[f.id] = (v as UploadedFile[]).filter((x) => x.id).map((x) => x.id);
      else if (f.type === "date" && f.options.includeTime) cells[f.id] = new Date(v as string).toISOString();
      else cells[f.id] = v;
    }
    setBusy(true);
    try {
      await api.publicFormSubmit(token!, cells);
      setDone(true);
      window.scrollTo({ top: 0 });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pf-page">
      <form className="pf-card" onSubmit={submit} noValidate>
        <div className="pf-band" style={{ background: accent }} />
        {done ? (
          <div className="pf-message">
            <CheckCircle2 size={40} className="ok" />
            <h2>Response submitted</h2>
            <p>{form.successMessage}</p>
            {form.allowAnother && (
              <button type="button" className="btn" onClick={() => { setValues({}); setDone(false); setMissing(new Set()); }}>
                Submit another response
              </button>
            )}
          </div>
        ) : (
          <>
            <header className="pf-head">
              <h1>{form.title}</h1>
              {form.description && <p className="pf-desc">{form.description}</p>}
            </header>
            <div className="pf-fields">
              {form.fields.map((f) => (
                <div key={f.id} id={`q-${f.id}`} className={"pf-q" + (missing.has(f.id) ? " missing" : "")}>
                  <div className="pf-label">{f.label}{f.required && <span className="req" title="Required">*</span>}</div>
                  {f.help && <div className="pf-help">{f.help}</div>}
                  <FormInput
                    field={f}
                    value={values[f.id]}
                    onChange={(v) => { setValues((s) => ({ ...s, [f.id]: v })); if (missing.has(f.id)) setMissing((m) => { const n = new Set(m); n.delete(f.id); return n; }); }}
                    upload={(file, onProgress) => api.publicFormUpload(token!, file, onProgress)}
                  />
                  {missing.has(f.id) && <div className="pf-err">This question is required.</div>}
                </div>
              ))}
            </div>
            {error && <div className="error banner" style={{ margin: "0 0 4px" }}>{error}</div>}
            <div className="pf-foot">
              <button className="btn primary lg" disabled={busy} style={{ background: undefined }}>{busy ? "Sending…" : form.submitText || "Submit"}</button>
            </div>
          </>
        )}
      </form>
      <div className="pf-brand"><LogoMark size={18} /> {base.name} · made with Brill Tables</div>
    </div>
  );
}
