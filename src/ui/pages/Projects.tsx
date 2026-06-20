import React, { useState } from 'react';
import { useApi, useToast, Money, Empty, Modal, Field, ErrorBanner, NumberField, DateField, PickContact, Badge } from '../components';
import { api, toCents, fromCents, todayIso, fmtDate } from '../api';

const STATUSES = ['IN_PROGRESS', 'ON_HOLD', 'COMPLETED'];
const statusLabel = (s: string) => ({ IN_PROGRESS: 'In progress', ON_HOLD: 'On hold', COMPLETED: 'Completed' } as any)[s] ?? s;
const hm = (min: number) => `${Math.floor((min || 0) / 60)}h ${(min || 0) % 60}m`;

export default function Projects() {
  const [selected, setSelected] = useState<number | null>(null);
  if (selected) return <ProjectDetail id={selected} onBack={() => setSelected(null)} />;
  return <ProjectList onOpen={setSelected} />;
}

function ProjectList({ onOpen }: { onOpen: (id: number) => void }) {
  const { data, reload } = useApi<any[]>('projects.listProjects');
  const [creating, setCreating] = useState(false);

  return (
    <>
      <div className="page-head">
        <h1>Projects</h1>
        <span className="grow" />
        <button className="btn primary" onClick={() => setCreating(true)}>+ New project</button>
      </div>
      {!data || data.length === 0 ? (
        <div className="card tight"><Empty title="No projects yet" sub="Track time and costs against a job, then bill it to the customer." actionLabel="+ New project" onAction={() => setCreating(true)} /></div>
      ) : (
        <div className="card tight">
          <table className="tbl">
            <thead><tr><th>Project</th><th>Customer</th><th></th><th>Time</th><th className="num">Unbilled</th><th className="num">Billed</th></tr></thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.id} style={{ cursor: 'pointer' }} onClick={() => onOpen(p.id)}>
                  <td><strong>{p.name}</strong>{p.code && <span className="muted small"> · {p.code}</span>}</td>
                  <td>{p.contact_name ?? <span className="muted">—</span>}</td>
                  <td><Badge status={p.status} label={statusLabel(p.status)} /></td>
                  <td className="muted small">{hm(p.logged_minutes)}</td>
                  <td className="num">{p.unbilled_total ? <Money cents={p.unbilled_total} /> : <span className="muted">—</span>}</td>
                  <td className="num"><Money cents={p.billed_total} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <ProjectModal onClose={() => setCreating(false)} onSaved={() => { setCreating(false); reload(); }} />}
    </>
  );
}

function ProjectDetail({ id, onBack }: { id: number; onBack: () => void }) {
  const { data, error, reload } = useApi<any>('projects.getProject', id);
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [taskEdit, setTaskEdit] = useState<any | null>(null);
  const [timeEdit, setTimeEdit] = useState<any | null>(null);
  const [costEdit, setCostEdit] = useState<any | null>(null);
  const [billing, setBilling] = useState(false);
  const [busy, setBusy] = useState(false);

  if (error) return <ErrorBanner msg={error} />;
  if (!data) return null;
  const { project, tasks, time, costs, summary } = data;

  async function act(fn: () => Promise<any>, msg: string) {
    setBusy(true);
    try { await fn(); toast(msg); reload(); } catch (e: any) { toast(e.message); } finally { setBusy(false); }
  }

  return (
    <>
      <div className="page-head">
        <button className="btn small" onClick={onBack}>← Projects</button>
        <h1 style={{ marginLeft: 12 }}>{project.name}</h1>
        <Badge status={project.status} label={statusLabel(project.status)} />
        <span className="grow" />
        <button className="btn small" onClick={() => setEditing(true)}>Edit</button>
      </div>
      <p className="muted small" style={{ marginTop: -6 }}>
        {project.contact_name ?? 'No customer'}{project.deadline ? ` · due ${fmtDate(project.deadline)}` : ''}
      </p>

      {/* Summary */}
      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <SummaryCard label="Estimate" value={summary.estimate} />
        <SummaryCard label="Billed to date" value={summary.billed_total} />
        <SummaryCard label="Unbilled (ready)" value={summary.unbilled_total} accent />
        <SummaryCard label="Costs" value={summary.cost_total} />
      </div>

      <div className="btn-row" style={{ marginBottom: 16 }}>
        <button className="btn primary" disabled={busy || summary.unbilled_total <= 0} onClick={() => setBilling(true)}>Create invoice from unbilled</button>
        {summary.unbilled_total > 0 && (
          <span className="muted small" style={{ alignSelf: 'center' }}>
            <Money cents={summary.unbilled_total} /> ready · {hm(time.filter((t: any) => t.billable && !t.invoiced && t.task_id).reduce((s: number, t: any) => s + t.minutes, 0))} of billable time + costs
          </span>
        )}
      </div>

      {/* Tasks */}
      <Section title="Tasks & rates" onAdd={() => setTaskEdit({ project_id: id })} addLabel="+ Task">
        {tasks.length === 0 ? <Muted>No tasks. Add a task with an hourly rate so time can be billed.</Muted> : (
          <table className="tbl">
            <thead><tr><th>Task</th><th className="num">Rate / hr</th><th></th></tr></thead>
            <tbody>
              {tasks.map((t: any) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td className="num">{t.rate != null ? <Money cents={t.rate} /> : <span className="muted">—</span>}</td>
                  <td className="num"><button className="btn small" onClick={() => setTaskEdit(t)}>Edit</button> <button className="btn small danger" disabled={busy} onClick={() => act(() => api('projects.removeTask', t.id), 'Task removed')}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {/* Time */}
      <Section title="Time" onAdd={() => setTimeEdit({ project_id: id, date: todayIso(), billable: true })} addLabel="+ Log time">
        {time.length === 0 ? <Muted>No time logged yet.</Muted> : (
          <table className="tbl">
            <thead><tr><th>Date</th><th>Task</th><th>Description</th><th className="num">Time</th><th className="num">Value</th><th></th></tr></thead>
            <tbody>
              {time.map((e: any) => (
                <tr key={e.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(e.date)}</td>
                  <td>{e.task_name ?? <span className="muted">—</span>}</td>
                  <td>{e.description}{!e.billable && <span className="badge" style={{ marginLeft: 6 }}>non-billable</span>}{e.invoiced ? <span className="badge green" style={{ marginLeft: 6 }}>invoiced</span> : ''}</td>
                  <td className="num">{hm(e.minutes)}</td>
                  <td className="num"><Money cents={e.value} /></td>
                  <td className="num">{!e.invoiced && <><button className="btn small" onClick={() => setTimeEdit(e)}>Edit</button> <button className="btn small danger" disabled={busy} onClick={() => act(() => api('projects.removeTime', e.id), 'Entry removed')}>Remove</button></>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {/* Costs */}
      <Section title="Costs" onAdd={() => setCostEdit({ project_id: id, date: todayIso(), billable: true })} addLabel="+ Add cost">
        {costs.length === 0 ? <Muted>No costs recorded.</Muted> : (
          <table className="tbl">
            <thead><tr><th>Date</th><th>Description</th><th className="num">Cost</th><th className="num">Charge</th><th></th></tr></thead>
            <tbody>
              {costs.map((c: any) => (
                <tr key={c.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(c.date)}</td>
                  <td>{c.description}{c.source_type === 'BILL' && <span className="badge" style={{ marginLeft: 6 }}>from bill</span>}{c.source_type === 'EXPENSECLAIM' && <span className="badge" style={{ marginLeft: 6 }}>from claim</span>}{c.source_type === 'SUPPLIERCREDIT' && <span className="badge" style={{ marginLeft: 6 }}>from credit</span>}{!c.billable && <span className="badge" style={{ marginLeft: 6 }}>non-billable</span>}{c.invoiced ? <span className="badge green" style={{ marginLeft: 6 }}>invoiced</span> : ''}</td>
                  <td className="num"><Money cents={c.cost_amount} /></td>
                  <td className="num"><Money cents={c.charge_amount} /></td>
                  <td className="num">{!c.invoiced && <><button className="btn small" onClick={() => setCostEdit(c)}>Edit</button> <button className="btn small danger" disabled={busy} onClick={() => act(() => api('projects.removeCost', c.id), 'Cost removed')}>Remove</button></>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {editing && <ProjectModal project={project} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); reload(); }} />}
      {taskEdit && <TaskModal task={taskEdit} onClose={() => setTaskEdit(null)} onSaved={() => { setTaskEdit(null); reload(); }} />}
      {timeEdit && <TimeModal entry={timeEdit} tasks={tasks} onClose={() => setTimeEdit(null)} onSaved={() => { setTimeEdit(null); reload(); }} />}
      {costEdit && <CostModal cost={costEdit} onClose={() => setCostEdit(null)} onSaved={() => { setCostEdit(null); reload(); }} />}
      {billing && <BillModal projectId={id} total={summary.unbilled_total} onClose={() => setBilling(false)} onSaved={() => { setBilling(false); reload(); toast('Draft invoice created — find it under Sales'); }} />}
    </>
  );
}

function SummaryCard({ label, value, accent }: { label: string; value: number | null; accent?: boolean }) {
  return (
    <div className="card tight" style={{ textAlign: 'center' }}>
      <div className="muted small">{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600, color: accent && value ? 'var(--green)' : undefined }}>{value == null ? '—' : <Money cents={value} />}</div>
    </div>
  );
}
function Section({ title, addLabel, onAdd, children }: { title: string; addLabel: string; onAdd: () => void; children: React.ReactNode }) {
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="btn-row" style={{ alignItems: 'center', marginBottom: 8 }}>
        <h3 style={{ margin: 0, flex: 1 }}>{title}</h3>
        <button className="btn small" onClick={onAdd}>{addLabel}</button>
      </div>
      {children}
    </div>
  );
}
const Muted = ({ children }: { children: React.ReactNode }) => <div className="muted small">{children}</div>;

function ProjectModal({ project, onClose, onSaved }: { project?: any; onClose: () => void; onSaved: () => void }) {
  const isNew = !project?.id;
  const [name, setName] = useState(project?.name ?? '');
  const [code, setCode] = useState(project?.code ?? '');
  const [contactId, setContactId] = useState<number | ''>(project?.contact_id ?? '');
  const [status, setStatus] = useState(project?.status ?? 'IN_PROGRESS');
  const [estimate, setEstimate] = useState(project?.estimate_amount != null ? String(fromCents(project.estimate_amount)) : '');
  const [deadline, setDeadline] = useState(project?.deadline ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (!name.trim()) { setErr('Give the project a name.'); return; }
    setBusy(true); setErr(null);
    try {
      await api(isNew ? 'projects.createProject' : 'projects.updateProject', {
        id: project?.id, name: name.trim(), code: code || null, contact_id: contactId || null,
        status, estimate_amount: estimate ? toCents(estimate) : null, deadline: deadline || null,
      });
      onSaved();
    } catch (e: any) { setErr(e.message); setBusy(false); }
  }

  return (
    <Modal title={isNew ? 'New project' : 'Edit project'} onClose={onClose}>
      {err && <ErrorBanner msg={err} />}
      <div className="form-row">
        <Field label="Name" grow={2}><input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        <Field label="Code"><input value={code} onChange={(e) => setCode(e.target.value)} placeholder="optional" /></Field>
      </div>
      <Field label="Customer"><PickContact value={contactId} onChange={setContactId} filter="CUSTOMERS" /></Field>
      <div className="form-row">
        <Field label="Status"><select value={status} onChange={(e) => setStatus(e.target.value)}>{STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}</select></Field>
        <Field label="Estimate"><NumberField value={estimate} onChange={setEstimate} label="estimate" allowNegative={false} min={0} placeholder="optional" /></Field>
        <Field label="Deadline"><DateField value={deadline} onChange={setDeadline} /></Field>
      </div>
      <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={save}>{isNew ? 'Create project' : 'Save'}</button>
      </div>
    </Modal>
  );
}

function TaskModal({ task, onClose, onSaved }: { task: any; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(task.name ?? '');
  const [rate, setRate] = useState(task.rate != null ? String(fromCents(task.rate)) : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    if (!name.trim()) { setErr('Give the task a name.'); return; }
    setBusy(true); setErr(null);
    try { await api('projects.saveTask', { id: task.id, project_id: task.project_id, name: name.trim(), rate: rate ? toCents(rate) : null }); onSaved(); }
    catch (e: any) { setErr(e.message); setBusy(false); }
  }
  return (
    <Modal title={task.id ? 'Edit task' : 'New task'} onClose={onClose}>
      {err && <ErrorBanner msg={err} />}
      <div className="form-row">
        <Field label="Task name" grow={2}><input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        <Field label="Hourly rate"><NumberField value={rate} onChange={setRate} label="rate" allowNegative={false} min={0} placeholder="e.g. 150" /></Field>
      </div>
      <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={save}>Save task</button>
      </div>
    </Modal>
  );
}

function TimeModal({ entry, tasks, onClose, onSaved }: { entry: any; tasks: any[]; onClose: () => void; onSaved: () => void }) {
  const [date, setDate] = useState(entry.date ?? todayIso());
  const [taskId, setTaskId] = useState<string>(entry.task_id ? String(entry.task_id) : '');
  const [hours, setHours] = useState(entry.minutes ? String(entry.minutes / 60) : '');
  const [description, setDescription] = useState(entry.description ?? '');
  const [billable, setBillable] = useState(entry.billable !== 0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    const h = Number(hours);
    if (!Number.isFinite(h) || h <= 0) { setErr('Enter the number of hours.'); return; }
    setBusy(true); setErr(null);
    try {
      await api('projects.logTime', { id: entry.id, project_id: entry.project_id, task_id: taskId ? Number(taskId) : null, date, minutes: Math.round(h * 60), description: description || null, billable });
      onSaved();
    } catch (e: any) { setErr(e.message); setBusy(false); }
  }
  return (
    <Modal title={entry.id ? 'Edit time' : 'Log time'} onClose={onClose}>
      {err && <ErrorBanner msg={err} />}
      <div className="form-row">
        <Field label="Date"><DateField value={date} onChange={setDate} /></Field>
        <Field label="Hours"><NumberField value={hours} onChange={setHours} label="hours" allowNegative={false} min={0} placeholder="e.g. 2.5" /></Field>
        <Field label="Task" grow={2}>
          <select value={taskId} onChange={(e) => setTaskId(e.target.value)}>
            <option value="">(no task — not billable)</option>
            {tasks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Description"><input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What did you work on?" /></Field>
      <label className="check" style={{ marginTop: 10 }}><input type="checkbox" checked={billable} onChange={(e) => setBillable(e.target.checked)} /> Billable</label>
      <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={save}>Save</button>
      </div>
    </Modal>
  );
}

function CostModal({ cost, onClose, onSaved }: { cost: any; onClose: () => void; onSaved: () => void }) {
  const imported = !!cost.source_type && cost.source_type !== 'MANUAL';
  const [date, setDate] = useState(cost.date ?? todayIso());
  const [description, setDescription] = useState(cost.description ?? '');
  const [amount, setAmount] = useState(cost.cost_amount != null ? String(fromCents(cost.cost_amount)) : '');
  const [markup, setMarkup] = useState(cost.markup_percent != null ? String(cost.markup_percent) : '0');
  const [billable, setBillable] = useState(cost.billable !== 0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    setBusy(true); setErr(null);
    try {
      if (imported) {
        await api('projects.updateCostBilling', { id: cost.id, markup_percent: Number(markup) || 0, billable });
      } else {
        const a = Number(amount);
        if (!Number.isFinite(a) || a < 0) { setErr('Enter the cost amount.'); setBusy(false); return; }
        await api('projects.addCost', { id: cost.id, project_id: cost.project_id, date, description: description || null, cost_amount: toCents(amount), markup_percent: Number(markup) || 0, billable });
      }
      onSaved();
    } catch (e: any) { setErr(e.message); setBusy(false); }
  }
  return (
    <Modal title={cost.id ? 'Edit cost' : 'Add cost'} onClose={onClose}>
      {err && <ErrorBanner msg={err} />}
      {imported && <p className="muted small" style={{ marginTop: 0 }}>This cost came from a {cost.source_type === 'BILL' ? 'bill' : cost.source_type === 'SUPPLIERCREDIT' ? 'supplier credit' : 'expense claim'}. Its amount and date follow the source document — set a markup or mark it non-billable here.</p>}
      <div className="form-row">
        <Field label="Date">{imported ? <input value={date} disabled /> : <DateField value={date} onChange={setDate} />}</Field>
        <Field label="Cost">{imported ? <input value={amount} disabled className="num" /> : <NumberField value={amount} onChange={setAmount} label="cost" allowNegative={false} min={0} />}</Field>
        <Field label="Markup %"><NumberField value={markup} onChange={setMarkup} label="markup" allowNegative={false} min={0} /></Field>
      </div>
      <Field label="Description">{imported ? <input value={description} disabled /> : <input value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
      <label className="check" style={{ marginTop: 10 }}><input type="checkbox" checked={billable} onChange={(e) => setBillable(e.target.checked)} /> Billable to customer</label>
      <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={save}>Save cost</button>
      </div>
    </Modal>
  );
}

function BillModal({ projectId, total, onClose, onSaved }: { projectId: number; total: number; onClose: () => void; onSaved: () => void }) {
  const [date, setDate] = useState(todayIso());
  const [dueDate, setDueDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    setBusy(true); setErr(null);
    try { await api('projects.invoiceUnbilled', projectId, { date, due_date: dueDate || undefined }); onSaved(); }
    catch (e: any) { setErr(e.message); setBusy(false); }
  }
  return (
    <Modal title="Create invoice from unbilled" onClose={onClose}>
      {err && <ErrorBanner msg={err} />}
      <p className="muted small">A draft invoice will be created for the customer, with a line per task (billable hours × rate) and one per billable cost. Total <Money cents={total} />.</p>
      <div className="form-row">
        <Field label="Invoice date"><DateField value={date} onChange={setDate} /></Field>
        <Field label="Due date (optional)"><DateField value={dueDate} onChange={setDueDate} /></Field>
      </div>
      <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={save}>Create draft invoice</button>
      </div>
    </Modal>
  );
}
