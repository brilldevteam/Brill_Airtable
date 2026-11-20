import {
  ACTION_LABELS, COMPUTED_TYPES, LIST_OPS, OPERATOR_LABELS, TRIGGER_LABELS, TRIGGER_TYPES, VALUELESS_OPS, operatorsFor,
  type Action, type ActionType, type Automation, type AutomationRun, type Field, type FilterCondition, type Table, type Trigger, type TriggerType,
} from "@brill/shared";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle, Braces, CheckCircle2, Globe, Mail, PencilLine, Play, Plus, Sparkles, SquarePlus, Trash2, X, Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useDialogs } from "./Dialogs";
import { FieldIcon } from "./fieldIcons";
import { Popover, anchorOf, type Anchor } from "./Popover";

const ACTION_ICONS: Record<ActionType, typeof Mail> = { updateRecord: PencilLine, createRecord: SquarePlus, sendEmail: Mail, webhook: Globe };
const newCondId = () => Math.random().toString(36).slice(2, 10);

function timeAgo(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleString();
}

/** Plain-language summary of a trigger, for the list. */
function describe(t: Trigger, tables: Table[], fieldsOf: (id: string) => Field[]) {
  const table = tables.find((x) => x.id === t.tableId)?.name ?? "a table";
  switch (t.type) {
    case "recordCreated": return `New record in ${table}`;
    case "formSubmitted": return `Form submitted in ${table}`;
    case "recordUpdated": {
      const names = t.fieldIds.map((id) => fieldsOf(t.tableId).find((f) => f.id === id)?.name).filter(Boolean);
      return `${table}: ${names.length ? names.join(", ") + " changed" : "any field changed"}`;
    }
    case "recordMatches": return `${table}: record matches ${t.conditions.length} condition${t.conditions.length === 1 ? "" : "s"}`;
  }
}

/** Base automations: "when … then …", with a run history. Opened from the base header. */
export function AutomationsPanel({ baseId, tables, onClose }: { baseId: string; tables: Table[]; onClose: () => void }) {
  const qc = useQueryClient();
  const dialogs = useDialogs();
  const key = ["automations", baseId];
  const q = useQuery({ queryKey: key, queryFn: () => api.automations(baseId) });
  const schemas = useQueries({ queries: tables.map((t) => ({ queryKey: ["table", t.id], queryFn: () => api.table(t.id) })) });
  const fieldsOf = (tableId: string) => schemas.find((s) => s.data?.table.id === tableId)?.data?.fields ?? [];
  const viewsOf = (tableId: string) => schemas.find((s) => s.data?.table.id === tableId)?.data?.views ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const list = q.data?.automations ?? [];
  const current = list.find((a) => a.id === selected) ?? list[0];

  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && !document.querySelector(".popover-backdrop") && document.querySelectorAll(".modal-backdrop").length === 1 && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const create = async () => {
    const first = tables[0];
    if (!first) return;
    const { automation } = await api.createAutomation(baseId, {
      name: "Untitled automation",
      trigger: { type: "recordCreated", tableId: first.id, fieldIds: [], conjunction: "and", conditions: [], viewId: null },
      actions: [],
    });
    await qc.invalidateQueries({ queryKey: key });
    setSelected(automation.id);
  };
  const toggle = async (a: Automation) => {
    await api.updateAutomation(a.id, { enabled: !a.enabled });
    await qc.invalidateQueries({ queryKey: key });
  };
  const remove = async (a: Automation) => {
    const ok = await dialogs.confirm({ title: `Delete “${a.name}”?`, message: "It stops running, and its run history is deleted.", confirmText: "Delete automation", danger: true });
    if (!ok) return;
    await api.deleteAutomation(a.id);
    setSelected(null);
    await qc.invalidateQueries({ queryKey: key });
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal auto-modal" role="dialog" aria-modal="true" aria-labelledby="auto-title">
        <div className="auto-head">
          <div className="modal-icon"><Zap size={18} /></div>
          <div>
            <h3 id="auto-title">Automations</h3>
            <p className="modal-sub">When something happens in this base, do things for you — update records, send emails, call webhooks.</p>
          </div>
          <div className="spacer" />
          <button className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="auto-body">
          <aside className="auto-list">
            <button className="btn primary block" onClick={create}><Plus size={15} /> New automation</button>
            {q.isLoading && <div className="center"><div className="spinner" /></div>}
            {list.map((a) => (
              <div key={a.id} className={"auto-item" + (a.id === current?.id ? " on" : "")} onClick={() => setSelected(a.id)} role="button">
                <div className="auto-item-top">
                  <strong>{a.name}</strong>
                  <Switch on={a.enabled} onChange={() => toggle(a)} />
                </div>
                <span className="auto-item-sub">{describe(a.trigger, tables, fieldsOf)}</span>
                <span className="auto-item-sub">
                  {a.actions.length} action{a.actions.length === 1 ? "" : "s"}
                  {a.lastRun && <> · <span className={"run-dot " + a.lastRun.status} /> {timeAgo(a.lastRun.at)}</>}
                </span>
              </div>
            ))}
            {q.data && list.length === 0 && (
              <div className="auto-empty">
                <Sparkles size={20} />
                <strong>No automations yet</strong>
                <span>For example: when a task's Status becomes “Ready for review”, email the client.</span>
              </div>
            )}
          </aside>
          {current ? (
            <Editor
              key={current.id + current.updatedAt}
              automation={current}
              tables={tables}
              fieldsOf={fieldsOf}
              viewsOf={viewsOf}
              onSaved={() => qc.invalidateQueries({ queryKey: key })}
              onDelete={() => remove(current)}
              onToggle={() => toggle(current)}
            />
          ) : (
            <div className="auto-editor auto-placeholder">Create an automation to get started.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function Switch({ on, onChange, label }: { on: boolean; onChange: () => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      title={on ? "On — click to turn off" : "Off — click to turn on"}
      className={"switch" + (on ? " on" : "")}
      onClick={(e) => { e.stopPropagation(); onChange(); }}
    >
      <span />{label && <em>{label}</em>}
    </button>
  );
}

function Editor({ automation, tables, fieldsOf, viewsOf, onSaved, onDelete, onToggle }: {
  automation: Automation; tables: Table[]; fieldsOf: (id: string) => Field[]; viewsOf: (id: string) => { id: string; name: string; type: string }[];
  onSaved: () => void; onDelete: () => void; onToggle: () => void;
}) {
  const [name, setName] = useState(automation.name);
  const [trigger, setTrigger] = useState<Trigger>(automation.trigger);
  const [actions, setActions] = useState<Action[]>(automation.actions);
  const [tab, setTab] = useState<"setup" | "runs">("setup");
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testRun, setTestRun] = useState<AutomationRun | null>(null);
  const [addMenu, setAddMenu] = useState<Anchor | null>(null);
  const dirty = JSON.stringify({ name, trigger, actions }) !== JSON.stringify({ name: automation.name, trigger: automation.trigger, actions: automation.actions });
  const fields = fieldsOf(trigger.tableId);

  const save = async () => {
    setBusy("save");
    setError(null);
    try {
      await api.updateAutomation(automation.id, { name: name.trim() || "Untitled automation", trigger, actions });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const test = async () => {
    setBusy("test");
    setError(null);
    setTestRun(null);
    try {
      if (dirty) await api.updateAutomation(automation.id, { name: name.trim() || "Untitled automation", trigger, actions });
      const { run } = await api.testAutomation(automation.id);
      setTestRun(run);
      if (dirty) onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const setAction = (i: number, a: Action) => setActions(actions.map((x, j) => (j === i ? a : x)));
  const addAction = (type: ActionType) => {
    setAddMenu(null);
    const a: Action =
      type === "updateRecord" ? { type, fields: {} }
        : type === "createRecord" ? { type, tableId: tables.find((t) => t.id !== trigger.tableId)?.id ?? trigger.tableId, fields: {} }
        : type === "sendEmail" ? { type, to: "", subject: "", body: "" }
        : { type, url: "https://" };
    setActions([...actions, a]);
  };

  return (
    <section className="auto-editor">
      <div className="auto-editor-head">
        <input className="auto-name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Automation name" maxLength={120} />
        <Switch on={automation.enabled} onChange={onToggle} label={automation.enabled ? "On" : "Off"} />
        <button className="icon-btn danger" title="Delete automation" onClick={onDelete}><Trash2 size={16} /></button>
      </div>
      <div className="auto-tabs">
        <button className={tab === "setup" ? "on" : ""} onClick={() => setTab("setup")}>Setup</button>
        <button className={tab === "runs" ? "on" : ""} onClick={() => setTab("runs")}>Run history</button>
      </div>

      {tab === "runs" ? <RunHistory automationId={automation.id} /> : (
        <div className="auto-flow">
          <div className="auto-step trigger">
            <div className="auto-step-label"><Zap size={14} /> When</div>
            <div className="auto-row">
              <select value={trigger.type} onChange={(e) => setTrigger({ ...trigger, type: e.target.value as TriggerType })}>
                {TRIGGER_TYPES.map((t) => <option key={t} value={t}>{TRIGGER_LABELS[t]}</option>)}
              </select>
              <span className="auto-in">in</span>
              <select value={trigger.tableId} onChange={(e) => setTrigger({ ...trigger, tableId: e.target.value, fieldIds: [], conditions: [], viewId: null })}>
                {tables.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            {trigger.type === "recordUpdated" && (
              <div className="auto-sub">
                <span className="auto-hint">Only when these fields change (none ticked = any field):</span>
                <div className="auto-checks">
                  {fields.filter((f) => !COMPUTED_TYPES.has(f.type)).map((f) => (
                    <label key={f.id} className="row">
                      <input
                        type="checkbox"
                        checked={trigger.fieldIds.includes(f.id)}
                        onChange={(e) => setTrigger({ ...trigger, fieldIds: e.target.checked ? [...trigger.fieldIds, f.id] : trigger.fieldIds.filter((x) => x !== f.id) })}
                      />
                      <FieldIcon type={f.type} size={13} /> {f.name}
                    </label>
                  ))}
                </div>
              </div>
            )}
            {trigger.type === "recordMatches" && (
              <Conditions fields={fields} trigger={trigger} onChange={setTrigger} />
            )}
            {trigger.type === "formSubmitted" && (
              <div className="auto-row">
                <span className="auto-in">Form</span>
                <select value={trigger.viewId ?? ""} onChange={(e) => setTrigger({ ...trigger, viewId: e.target.value || null })}>
                  <option value="">Choose a form…</option>
                  {viewsOf(trigger.tableId).filter((v) => v.type === "form").map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
              </div>
            )}
          </div>

          {actions.map((a, i) => {
            const Icon = ACTION_ICONS[a.type];
            return (
              <div key={i} className="auto-step">
                <div className="auto-step-label">
                  <Icon size={14} /> {i === 0 ? "Then" : "And then"} · {ACTION_LABELS[a.type]}
                  <div className="spacer" />
                  <button className="icon-btn" title="Remove this action" onClick={() => setActions(actions.filter((_, j) => j !== i))}><X size={15} /></button>
                </div>
                <ActionEditor action={a} onChange={(x) => setAction(i, x)} tables={tables} fieldsOf={fieldsOf} triggerFields={fields} triggerTableId={trigger.tableId} />
              </div>
            );
          })}
          <button className="auto-add" onClick={(e) => setAddMenu(anchorOf(e.currentTarget))}><Plus size={15} /> Add action</button>
          {addMenu && (
            <Popover anchor={addMenu} onClose={() => setAddMenu(null)} minWidth={220}>
              <div className="menu">
                {(Object.keys(ACTION_LABELS) as ActionType[]).map((t) => {
                  const Icon = ACTION_ICONS[t];
                  return <button key={t} onClick={() => addAction(t)}><Icon size={15} /> {ACTION_LABELS[t]}</button>;
                })}
              </div>
            </Popover>
          )}

          {testRun && <RunCard run={testRun} />}
          {error && <div className="error banner" style={{ margin: 0 }}>{error}</div>}
          <div className="auto-foot">
            <span className="auto-hint">Type {"{Field name}"} in any text to use the record's value — or use the <Braces size={12} /> button.</span>
            <div className="spacer" />
            <button className="btn" onClick={test} disabled={busy !== null || actions.length === 0} title="Run the actions now on the newest record in the table">
              <Play size={14} /> {busy === "test" ? "Testing…" : "Test"}
            </button>
            <button className="btn primary" onClick={save} disabled={!dirty || busy !== null}>{busy === "save" ? "Saving…" : dirty ? "Save" : "Saved"}</button>
          </div>
        </div>
      )}
    </section>
  );
}

function Conditions({ fields, trigger, onChange }: { fields: Field[]; trigger: Trigger; onChange: (t: Trigger) => void }) {
  const set = (conditions: FilterCondition[]) => onChange({ ...trigger, conditions });
  const usable = fields.filter((f) => f.type !== "attachment");
  return (
    <div className="auto-sub">
      {trigger.conditions.map((c, i) => {
        const f = fields.find((x) => x.id === c.fieldId);
        const ops = f ? operatorsFor(f) : [];
        return (
          <div key={c.id} className="auto-row">
            <span className="auto-in">{i === 0 ? "Where" : (
              <select className="mini" value={trigger.conjunction} onChange={(e) => onChange({ ...trigger, conjunction: e.target.value as "and" | "or" })}>
                <option value="and">and</option>
                <option value="or">or</option>
              </select>
            )}</span>
            <select value={c.fieldId} onChange={(e) => {
              const nf = fields.find((x) => x.id === e.target.value)!;
              set(trigger.conditions.map((x, j) => (j === i ? { ...x, fieldId: nf.id, operator: operatorsFor(nf)[0], value: null } : x)));
            }}>
              {usable.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
            <select value={c.operator} onChange={(e) => set(trigger.conditions.map((x, j) => (j === i ? { ...x, operator: e.target.value as FilterCondition["operator"], value: null } : x)))}>
              {ops.map((o) => <option key={o} value={o}>{OPERATOR_LABELS[o]}</option>)}
            </select>
            {f && !VALUELESS_OPS.has(c.operator) && (
              f.options.choices?.length ? (
                LIST_OPS.has(c.operator) ? (
                  <select multiple value={(c.value as string[]) ?? []} onChange={(e) => set(trigger.conditions.map((x, j) => (j === i ? { ...x, value: [...e.target.selectedOptions].map((o) => o.value) } : x)))}>
                    {f.options.choices.map((ch) => <option key={ch.id} value={ch.id}>{ch.name}</option>)}
                  </select>
                ) : (
                  <select value={(c.value as string) ?? ""} onChange={(e) => set(trigger.conditions.map((x, j) => (j === i ? { ...x, value: e.target.value || null } : x)))}>
                    <option value="">Choose…</option>
                    {f.options.choices.map((ch) => <option key={ch.id} value={ch.id}>{ch.name}</option>)}
                  </select>
                )
              ) : (
                <input value={c.value === null || c.value === undefined ? "" : String(c.value)} placeholder="value"
                  onChange={(e) => set(trigger.conditions.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
              )
            )}
            <button className="icon-btn" title="Remove condition" onClick={() => set(trigger.conditions.filter((_, j) => j !== i))}><X size={15} /></button>
          </div>
        );
      })}
      <button className="link" onClick={() => {
        const f = usable[0];
        if (f) set([...trigger.conditions, { id: newCondId(), fieldId: f.id, operator: operatorsFor(f)[0], value: null }]);
      }}>
        <Plus size={14} /> Add condition
      </button>
      <span className="auto-hint">Runs once each time a record starts matching — not again while it keeps matching.</span>
    </div>
  );
}

function ActionEditor({ action, onChange, tables, fieldsOf, triggerFields, triggerTableId }: {
  action: Action; onChange: (a: Action) => void; tables: Table[]; fieldsOf: (id: string) => Field[]; triggerFields: Field[]; triggerTableId: string;
}) {
  switch (action.type) {
    case "updateRecord":
      return <FieldValues fields={fieldsOf(triggerTableId)} values={action.fields} tokens={triggerFields} onChange={(fields) => onChange({ ...action, fields })} />;
    case "createRecord":
      return (
        <>
          <div className="auto-row">
            <span className="auto-in">In table</span>
            <select value={action.tableId} onChange={(e) => onChange({ ...action, tableId: e.target.value, fields: {} })}>
              {tables.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <FieldValues fields={fieldsOf(action.tableId)} values={action.fields} tokens={triggerFields} onChange={(fields) => onChange({ ...action, fields })} />
        </>
      );
    case "sendEmail":
      return (
        <div className="auto-sub">
          <label className="auto-label">To
            <TokenInput value={action.to} tokens={triggerFields} placeholder="client@example.com, {Email}, {Assignee}" onChange={(to) => onChange({ ...action, to })} />
          </label>
          <label className="auto-label">Subject
            <TokenInput value={action.subject} tokens={triggerFields} placeholder="{Name} is ready for review" onChange={(subject) => onChange({ ...action, subject })} />
          </label>
          <label className="auto-label">Message
            <TokenInput multiline value={action.body} tokens={triggerFields} placeholder={"Hi,\n\n{Name} is ready. You can see it here: {Record URL}"} onChange={(body) => onChange({ ...action, body })} />
          </label>
          <span className="auto-hint">People fields (User, Created by) in To use the person's email address.</span>
        </div>
      );
    case "webhook":
      return (
        <div className="auto-sub">
          <label className="auto-label">URL
            <input value={action.url} placeholder="https://hooks.example.com/…" onChange={(e) => onChange({ ...action, url: e.target.value })} />
          </label>
          <span className="auto-hint">Sends a POST with the record's fields as JSON — works with Zapier, Make, n8n, Slack workflows and your own servers.</span>
        </div>
      );
  }
}

/** "Set field → to value" rows. Values can use {tokens}; select names, link names, dates and numbers are converted. */
function FieldValues({ fields, values, tokens, onChange }: {
  fields: Field[]; values: Record<string, string>; tokens: Field[]; onChange: (v: Record<string, string>) => void;
}) {
  const settable = fields.filter((f) => !COMPUTED_TYPES.has(f.type) && f.type !== "attachment");
  const unused = settable.filter((f) => !(f.id in values));
  return (
    <div className="auto-sub">
      {Object.entries(values).map(([fid, v]) => {
        const f = fields.find((x) => x.id === fid);
        return (
          <div key={fid} className="auto-row">
            <span className="auto-field">{f ? <><FieldIcon type={f.type} size={13} /> {f.name}</> : "(deleted field)"}</span>
            <TokenInput
              value={v}
              tokens={tokens}
              placeholder={f?.options.choices?.length ? `e.g. ${f.options.choices[0].name}` : f?.type === "checkbox" ? "yes / no" : f?.type === "date" ? "e.g. 2026-12-01" : "value or {Field}"}
              onChange={(nv) => onChange({ ...values, [fid]: nv })}
            />
            <button className="icon-btn" title="Don't set this field" onClick={() => { const n = { ...values }; delete n[fid]; onChange(n); }}><X size={15} /></button>
          </div>
        );
      })}
      {unused.length > 0 && (
        <select className="auto-add-field" value="" onChange={(e) => e.target.value && onChange({ ...values, [e.target.value]: "" })}>
          <option value="">+ Set a field…</option>
          {unused.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
      )}
    </div>
  );
}

/** Text box with a button that inserts {Field} tokens at the cursor. */
function TokenInput({ value, onChange, tokens, placeholder, multiline }: {
  value: string; onChange: (v: string) => void; tokens: Field[]; placeholder?: string; multiline?: boolean;
}) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const [menu, setMenu] = useState<Anchor | null>(null);
  const all = useMemo(() => [...tokens.map((f) => ({ name: f.name, type: f.type })), { name: "Record URL", type: null }], [tokens]);
  const insert = (name: string) => {
    setMenu(null);
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const token = `{${name}}`;
    onChange(value.slice(0, start) + token + value.slice(end));
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(start + token.length, start + token.length); });
  };
  return (
    <div className={"token-input" + (multiline ? " multi" : "")}>
      {multiline
        ? <textarea ref={ref} rows={5} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
        : <input ref={ref} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />}
      <button type="button" className="icon-btn" title="Insert a field from the record" onClick={(e) => setMenu(anchorOf(e.currentTarget))}><Braces size={14} /></button>
      {menu && (
        <Popover anchor={menu} onClose={() => setMenu(null)} minWidth={200}>
          <div className="menu token-menu">
            <div className="menu-label">Insert from the record</div>
            {all.map((t) => (
              <button key={t.name} onClick={() => insert(t.name)}>
                {t.type ? <FieldIcon type={t.type} size={13} /> : <Globe size={13} />} {t.name}
              </button>
            ))}
          </div>
        </Popover>
      )}
    </div>
  );
}

function RunCard({ run }: { run: AutomationRun }) {
  return (
    <div className={"run-card " + run.status}>
      <div className="run-card-head">
        {run.status === "success" ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
        <strong>{run.test ? "Test run" : "Run"} {run.status === "success" ? "succeeded" : "failed"}</strong>
        <span className="muted small">on “{run.recordName || "Unnamed record"}” · {timeAgo(run.startedAt)}</span>
      </div>
      <ul>
        {run.steps.map((s, i) => (
          <li key={i} className={s.ok ? "ok" : "bad"}>{ACTION_LABELS[s.action]}: {s.message}</li>
        ))}
        {run.steps.length === 0 && <li>No actions.</li>}
      </ul>
    </div>
  );
}

function RunHistory({ automationId }: { automationId: string }) {
  const q = useQuery({ queryKey: ["automationRuns", automationId], queryFn: () => api.automationRuns(automationId), refetchInterval: 5000 });
  const runs = q.data?.runs ?? [];
  return (
    <div className="auto-runs">
      {q.isLoading && <div className="center"><div className="spinner" /></div>}
      {q.data && runs.length === 0 && <div className="auto-placeholder">No runs yet. Turn the automation on, or press Test.</div>}
      {runs.map((r) => <RunCard key={r.id} run={r} />)}
    </div>
  );
}
