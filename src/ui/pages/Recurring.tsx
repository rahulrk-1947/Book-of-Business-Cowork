import React, { useState } from 'react';
import { useApi, useToast, Money, Badge, Empty, Modal, Field, PickContact, PickAccount, PickTaxRate, ErrorBanner, ConfirmDanger, SearchSelect } from '../components';
import { DateField } from '../components';
import { api, fmtDate, toCents, fromCents, todayIso } from '../api';

const FREQ_LABEL: Record<string, string> = { WEEKLY: 'Weekly', MONTHLY: 'Monthly', YEARLY: 'Yearly' };

function describe(t: any): string {
  const n = t.every_n > 1 ? `every ${t.every_n} ` : '';
  const unit = t.frequency === 'WEEKLY' ? 'weeks' : t.frequency === 'MONTHLY' ? 'months' : 'years';
  return t.every_n > 1 ? `${n}${unit}` : FREQ_LABEL[t.frequency].toLowerCase();
}

export default function Recurring() {
  const { data, error, reload } = useApi<any[]>('recurring.list');
  const { data: due } = useApi<number>('recurring.dueCount');
  const toast = useToast();
  const [editing, setEditing] = useState<any | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);

  async function act(fn: () => Promise<any>, msg: string) {
    setBusy(true);
    try { await fn(); toast(msg); reload(); } catch (e: any) { toast(e.message); } finally { setBusy(false); }
  }
  async function generateAllDue() {
    setBusy(true);
    try {
      const r = await api('recurring.generateDue');
      toast(r.count > 0 ? `Created ${r.count} document${r.count === 1 ? '' : 's'} from your schedules` : 'Nothing is due right now');
      reload();
    } catch (e: any) { toast(e.message); } finally { setBusy(false); }
  }

  return (
    <>
      <ErrorBanner msg={error} />
      <div className="page-head">
        <h1>Recurring invoices &amp; bills</h1>
        <div className="grow" />
        {(due ?? 0) > 0 && <button className="btn" disabled={busy} onClick={generateAllDue}>Generate {due} due now</button>}
        <button className="btn primary" onClick={() => setEditing({})}>+ New schedule</button>
      </div>

      <div className="card tight">
        {data && data.length === 0 ? (
          <Empty
            title="No recurring schedules yet"
            sub="Set up a template once and let it raise the invoice or bill on a schedule — weekly, monthly, or yearly."
            actionLabel="+ New schedule"
            onAction={() => setEditing({})}
          />
        ) : (
          <table className="tbl">
            <thead><tr><th>Name</th><th>Contact</th><th>Type</th><th>Repeats</th><th>Next</th><th>Status</th><th className="num">Amount</th><th /></tr></thead>
            <tbody>
              {(data ?? []).map((t: any) => (
                <tr key={t.id} className="click" {...rowKeyboard(() => setEditing(t))}>
                  <td><strong>{t.name}</strong>{t.auto_approve ? <div className="faint small">auto-approves</div> : <div className="faint small">creates drafts</div>}</td>
                  <td>{t.contact_name}</td>
                  <td>{t.type === 'ACCREC' ? 'Invoice' : 'Bill'}</td>
                  <td className="small">{describe(t)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{t.status === 'ENDED' ? '—' : fmtDate(t.next_date)}</td>
                  <td>
                    {t.status === 'ACTIVE' && <Badge status="AUTHORISED" />}
                    {t.status === 'PAUSED' && <span className="badge amber">paused</span>}
                    {t.status === 'ENDED' && <span className="badge">ended</span>}
                  </td>
                  <td className="num"><Money cents={t.rough_total} /></td>
                  <td onClick={(e) => e.stopPropagation()} style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {t.status !== 'ENDED' && <button className="btn small" disabled={busy} title="Create the next document now" onClick={() => act(() => api('recurring.runNow', t.id), 'Created the next document')}>Generate now</button>}
                    {t.status === 'ACTIVE' && <button className="btn small" disabled={busy} onClick={() => act(() => api('recurring.setStatus', t.id, 'PAUSED'), 'Paused')}>Pause</button>}
                    {t.status === 'PAUSED' && <button className="btn small" disabled={busy} onClick={() => act(() => api('recurring.setStatus', t.id, 'ACTIVE'), 'Resumed')}>Resume</button>}
                    <button className="btn small danger" disabled={busy} onClick={() => setConfirmDelete(t)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="muted small" style={{ marginTop: 12 }}>
        Schedules generate automatically when you open the app. Documents are created as <strong>drafts</strong> unless a schedule is set to approve automatically, so nothing posts to your accounts without your say-so.
      </p>

      {editing && <RecurringEditor template={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
      {confirmDelete && (
        <ConfirmDanger
          title={`Delete the “${confirmDelete.name}” schedule?`}
          lines={[
            'This stops it generating any more documents.',
            'Documents it already created are kept — they’re just no longer linked to the schedule.',
          ]}
          confirmLabel="Delete schedule"
          onClose={() => setConfirmDelete(null)}
          onConfirm={async () => { await act(() => api('recurring.remove', confirmDelete.id), 'Schedule deleted'); setConfirmDelete(null); }}
        />
      )}
    </>
  );
}

function rowKeyboard(onActivate: () => void) {
  return {
    tabIndex: 0, role: 'button' as const, onClick: onActivate,
    onKeyDown: (e: React.KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'A') return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onActivate(); }
    },
  };
}

type LineDraft = { item_id: number | ''; description: string; quantity: string; unit_amount: string; account_id: number | ''; tax_rate_id: number | null };
const blankLine = (): LineDraft => ({ item_id: '', description: '', quantity: '1', unit_amount: '', account_id: '', tax_rate_id: null });

function RecurringEditor({ template, onClose, onSaved }: { template: any; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const isNew = !template.id;
  const [type, setType] = useState<'ACCREC' | 'ACCPAY'>(template.type ?? 'ACCREC');
  const [name, setName] = useState(template.name ?? '');
  const [contact, setContact] = useState<number | ''>(template.contact_id ?? '');
  const [reference, setReference] = useState(template.reference ?? '');
  const [frequency, setFrequency] = useState(template.frequency ?? 'MONTHLY');
  const [everyN, setEveryN] = useState(String(template.every_n ?? 1));
  const [dueDays, setDueDays] = useState(String(template.due_days ?? 14));
  const [startDate, setStartDate] = useState(template.start_date ?? todayIso());
  const [endMode, setEndMode] = useState<'never' | 'on' | 'after'>(template.end_date ? 'on' : template.end_after ? 'after' : 'never');
  const [endDate, setEndDate] = useState(template.end_date ?? '');
  const [endAfter, setEndAfter] = useState(template.end_after ? String(template.end_after) : '');
  const [autoApprove, setAutoApprove] = useState(!!template.auto_approve);
  const [mode, setMode] = useState(template.line_amount_type ?? 'EXCLUSIVE');
  const [lines, setLines] = useState<LineDraft[]>([blankLine()]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string[]>([]);

  React.useEffect(() => {
    if (template.id) {
      api('recurring.get', template.id).then((t: any) => {
        setLines(t.lines.map((l: any) => ({ item_id: l.item_id ?? '', description: l.description, quantity: String(l.quantity), unit_amount: fromCents(l.unit_amount), account_id: l.account_id, tax_rate_id: l.tax_rate_id })));
      });
    }
  }, [template.id]);

  // Live preview of the next handful of issue dates.
  React.useEffect(() => {
    const t = setTimeout(() => {
      api('recurring.previewDates', { frequency, every_n: parseInt(everyN) || 1, start_date: startDate, end_date: endMode === 'on' ? endDate || null : null, end_after: endMode === 'after' ? parseInt(endAfter) || null : null }, 4)
        .then(setPreview).catch(() => setPreview([]));
    }, 200);
    return () => clearTimeout(t);
  }, [frequency, everyN, startDate, endMode, endDate, endAfter]);

  const setLine = (i: number, patch: Partial<LineDraft>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  async function save() {
    setErr(null);
    if (!name.trim()) return setErr('Give the schedule a name');
    if (!contact) return setErr('Choose a contact');
    const body = lines.filter((l) => l.description.trim() && l.account_id).map((l) => ({
      item_id: l.item_id || null, description: l.description, quantity: parseFloat(l.quantity) || 1,
      unit_amount: toCents(l.unit_amount), account_id: l.account_id as number, tax_rate_id: l.tax_rate_id,
    }));
    if (!body.length) return setErr('Add at least one line with a description and an account');
    setBusy(true);
    try {
      await api('recurring.save', {
        id: template.id, name, type, contact_id: contact, reference: reference || undefined, line_amount_type: mode,
        frequency, every_n: parseInt(everyN) || 1, due_days: parseInt(dueDays) || 0, start_date: startDate,
        end_date: endMode === 'on' ? endDate || null : null, end_after: endMode === 'after' ? parseInt(endAfter) || null : null,
        auto_approve: autoApprove, lines: body,
      });
      toast(isNew ? 'Schedule created' : 'Schedule saved');
      onSaved();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <Modal title={isNew ? 'New recurring schedule' : 'Edit schedule'} wide onClose={onClose}>
      <ErrorBanner msg={err} />
      <div className="form-row">
        <Field label="What is this?">
          <select value={type} onChange={(e) => setType(e.target.value as any)}>
            <option value="ACCREC">Invoice (money in)</option>
            <option value="ACCPAY">Bill (money out)</option>
          </select>
        </Field>
        <Field label="Schedule name" grow={2}><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Monthly retainer — Acme" /></Field>
      </div>
      <div className="form-row">
        <Field label={type === 'ACCREC' ? 'Customer' : 'Supplier'} grow={1.6}>
          <PickContact value={contact} onChange={setContact} filter={type === 'ACCREC' ? 'CUSTOMERS' : 'SUPPLIERS'} />
        </Field>
        <Field label="Reference (optional)"><input value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
      </div>

      <h3 style={{ margin: '8px 0' }}>Schedule</h3>
      <div className="form-row">
        <Field label="Repeat every">
          <div style={{ display: 'flex', gap: 6 }}>
            <input type="number" min="1" value={everyN} onChange={(e) => setEveryN(e.target.value)} style={{ width: 64 }} />
            <select value={frequency} onChange={(e) => setFrequency(e.target.value)}>
              <option value="WEEKLY">week(s)</option>
              <option value="MONTHLY">month(s)</option>
              <option value="YEARLY">year(s)</option>
            </select>
          </div>
        </Field>
        <Field label="First issue date"><DateField value={startDate} onChange={setStartDate} /></Field>
        <Field label="Due (days after issue)"><input type="number" min="0" value={dueDays} onChange={(e) => setDueDays(e.target.value)} style={{ width: 90 }} /></Field>
      </div>
      <div className="form-row">
        <Field label="Ends">
          <select value={endMode} onChange={(e) => setEndMode(e.target.value as any)}>
            <option value="never">Never (until I stop it)</option>
            <option value="on">On a date</option>
            <option value="after">After a number of times</option>
          </select>
        </Field>
        {endMode === 'on' && <Field label="End date"><DateField value={endDate} onChange={setEndDate} /></Field>}
        {endMode === 'after' && <Field label="Number of issues"><input type="number" min="1" value={endAfter} onChange={(e) => setEndAfter(e.target.value)} style={{ width: 110 }} /></Field>}
        <Field label="When created">
          <label className="check" style={{ marginTop: 6 }}>
            <input type="checkbox" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} /> Approve automatically
          </label>
        </Field>
      </div>
      {preview.length > 0 && (
        <p className="muted small">Next issues: {preview.map((d) => fmtDate(d)).join(' · ')}{preview.length >= 4 ? ' …' : ''}</p>
      )}

      <h3 style={{ margin: '14px 0 8px' }}>Lines</h3>
      <table className="tbl">
        <thead><tr><th>Description</th><th>Account</th><th className="num" style={{ width: 80 }}>Qty</th><th className="num" style={{ width: 120 }}>Unit</th><th style={{ width: 130 }}>Tax</th><th style={{ width: 30 }} /></tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td><input value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} placeholder="Description" /></td>
              <td><PickAccount value={l.account_id} onChange={(v) => setLine(i, { account_id: v })} /></td>
              <td><input className="num" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} /></td>
              <td><input className="num" value={l.unit_amount} onChange={(e) => setLine(i, { unit_amount: e.target.value })} placeholder="0.00" /></td>
              <td><PickTaxRate value={l.tax_rate_id} onChange={(v) => setLine(i, { tax_rate_id: v })} /></td>
              <td><button type="button" className="icon-btn" aria-label="Remove this line" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>✕</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ marginTop: 8 }}>
        <button className="btn small" onClick={() => setLines((ls) => {
          const prev = [...ls].reverse().find((l) => l.account_id || l.tax_rate_id != null);
          const seed = blankLine();
          if (prev) { seed.account_id = prev.account_id; seed.tax_rate_id = prev.tax_rate_id; }
          return [...ls, seed];
        })}>+ Add line</button>
      </div>

      <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 18 }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={save}>{isNew ? 'Create schedule' : 'Save schedule'}</button>
      </div>
    </Modal>
  );
}
