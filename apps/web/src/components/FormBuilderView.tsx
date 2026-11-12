import { FIELD_TYPE_LABELS, FORM_FIELD_TYPES, type FormConfig, type FormField } from "@brill/shared";
import { ArrowDown, ArrowUp, Eye, Globe, Plus, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type PublicFormField } from "../api";
import { FieldIcon } from "./fieldIcons";
import { FormInput } from "./FormInput";
import { ShareLinkDialog } from "./ShareLinkDialog";
import type { ViewContext } from "./TableWorkspace";

/** Build the form: choose questions, labels, help text, required; preview it; share it. */
export function FormBuilderView({ ctx }: { ctx: ViewContext }) {
  const { view, allFields, updateConfig } = ctx;
  const form = view.config.form;
  const editable = ctx.canEdit;
  const [sharing, setSharing] = useState(false);
  const share = useQuery({ queryKey: ["viewShare", view.id], queryFn: () => api.viewShare(view.id) });
  const live = share.data?.share?.enabled;

  const set = (patch: Partial<FormConfig>) => updateConfig({ form: { ...form, ...patch } });
  const setField = (i: number, patch: Partial<FormField>) => set({ fields: form.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) });
  const move = (i: number, d: number) => {
    const next = [...form.fields];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x);
    set({ fields: next });
  };
  const inForm = new Set(form.fields.map((f) => f.fieldId));
  const byId = new Map(allFields.map((f) => [f.id, f]));

  return (
    <div className="fb">
      <aside className="fb-fields">
        <div className="sidebar-label">Fields</div>
        <p className="muted small" style={{ margin: "0 8px 6px" }}>Click a field to add it to the form.</p>
        {allFields.map((f) => {
          const ok = FORM_FIELD_TYPES.has(f.type);
          const on = inForm.has(f.id);
          return (
            <button
              key={f.id}
              className={"fb-field" + (on ? " on" : "")}
              disabled={!ok || !editable}
              title={!ok ? (f.type === "link" ? "Linked records can't be on a public form" : "Calculated fields can't be on a form") : on ? "Remove from form" : "Add to form"}
              onClick={() => set({ fields: on ? form.fields.filter((x) => x.fieldId !== f.id) : [...form.fields, { fieldId: f.id, required: false, label: "", help: "" }] })}
            >
              <FieldIcon type={f.type} size={14} />
              <span>{f.name}</span>
              {ok && editable && (on ? <X size={14} className="fb-act" /> : <Plus size={14} className="fb-act" />)}
            </button>
          );
        })}
      </aside>

      <div className="fb-canvas">
        <div className="fb-bar">
          <span className={"fb-status" + (live ? " live" : "")}>{live ? <><Globe size={13} /> Public link on</> : "Not shared yet"}</span>
          <div className="spacer" />
          {live && <a className="btn sm" href={`/f/${share.data!.share!.token}`} target="_blank" rel="noreferrer"><Eye size={14} /> Open form</a>}
          <button className="btn primary sm" onClick={() => setSharing(true)}><Globe size={14} /> Share form</button>
        </div>

        <div className="fb-card">
          <div className="fb-band" />
          <input className="fb-title" disabled={!editable} value={form.title} placeholder="Form title" onChange={(e) => set({ title: e.target.value })} />
          <textarea className="fb-desc" disabled={!editable} rows={2} value={form.description} placeholder="Add a description (optional)" onChange={(e) => set({ description: e.target.value })} />

          {form.fields.length === 0 && <div className="empty" style={{ padding: 28 }}><p>Add fields from the list on the left.</p></div>}
          {form.fields.map((ff, i) => {
            const field = byId.get(ff.fieldId);
            if (!field) return null;
            const preview: PublicFormField = {
              id: field.id, type: field.type, label: ff.label || field.name, help: ff.help, required: ff.required,
              options: { choices: field.options.choices, precision: field.options.precision, includeTime: field.options.includeTime },
            };
            return (
              <div key={ff.fieldId} className="fb-q">
                <div className="fb-q-top">
                  <span className="fb-q-type"><FieldIcon type={field.type} size={13} /> {field.name} · {FIELD_TYPE_LABELS[field.type]}</span>
                  <div className="spacer" />
                  {editable && (
                    <>
                      <label className="row fb-req"><input type="checkbox" checked={ff.required} onChange={(e) => setField(i, { required: e.target.checked })} /> Required</label>
                      <button className="icon-btn" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} /></button>
                      <button className="icon-btn" title="Move down" disabled={i === form.fields.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} /></button>
                      <button className="icon-btn danger" title="Remove from form" onClick={() => set({ fields: form.fields.filter((_, j) => j !== i) })}><X size={14} /></button>
                    </>
                  )}
                </div>
                <input className="fb-label" disabled={!editable} value={ff.label} placeholder={field.name} onChange={(e) => setField(i, { label: e.target.value })} />
                <input className="fb-help" disabled={!editable} value={ff.help} placeholder="Help text (optional)" onChange={(e) => setField(i, { help: e.target.value })} />
                <div className="fb-preview"><FormInput field={preview} value={undefined} onChange={() => undefined} disabled /></div>
              </div>
            );
          })}

          <div className="fb-settings">
            <label>Button text<input disabled={!editable} value={form.submitText} onChange={(e) => set({ submitText: e.target.value })} /></label>
            <label>Message after submitting<textarea disabled={!editable} rows={2} value={form.successMessage} onChange={(e) => set({ successMessage: e.target.value })} /></label>
            <label className="row"><input type="checkbox" disabled={!editable} checked={form.allowAnother} onChange={(e) => set({ allowAnother: e.target.checked })} /> Show a “Submit another response” button</label>
          </div>
        </div>
      </div>

      {sharing && <ShareLinkDialog viewId={view.id} viewName={view.name} isForm canManage={ctx.canDesign} onClose={() => setSharing(false)} />}
    </div>
  );
}
