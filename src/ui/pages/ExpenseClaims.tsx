import { useState } from 'react';
import { useApi, useToast, Modal, Field, Badge, Empty, ErrorBanner, Spinner, PickAccount, PickTaxRate, PickProject, DateField } from '../components';
import { api, money, toCents, fromCents, todayIso, fmtDate, dateError } from '../api';

type LineDraft = { account_id: number | ''; description: string; amount: string; tax_rate_id: number | null; project_id: number | null };
const blankLine = (): LineDraft => ({ account_id: '', description: '', amount: '', tax_rate_id: null, project_id: null });

export default function ExpenseClaims() {
  const { data: claims, error, loading, reload } = useApi<any[]>('expenseclaims.list');
  const { data: out, reload: reloadOut } = useApi<any>('expenseclaims.outstanding');
  const [editing, setEditing] = useState<any | null>(null); // claim being created/edited, or null
  const [reimbursing, setReimbursing] = useState<any | null>(null);
  const toast = useToast();

  const refresh = () => { reload(); reloadOut(); };

  async function act(fn: () => Promise<any>, ok: string) {
    try { await fn(); toast(ok); refresh(); }
    catch (e: any) { toast(e.message || 'Something went wrong'); }
  }

  if (loading && claims == null) return error ? <ErrorBanner msg={error} /> : <Spinner />;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Expense claims</h1>
          <div className="muted small">Expenses paid out of pocket, claimed back from the business.{out && out.total > 0 ? ` Currently owed: ${money(out.total)}.` : ''}</div>
        </div>
        <button className="btn primary" onClick={() => setEditing({ date: todayIso(), reference: '', narration: '', line_amount_type: 'INCLUSIVE', lines: [blankLine()] })}>New claim</button>
      </div>

      {error && <ErrorBanner msg={error} />}

      {(!claims || claims.length === 0) ? (
        <Empty title="No expense claims yet." sub="Create one to record expenses someone paid personally, then reimburse them." />
      ) : (
        <table className="tbl">
          <thead>
            <tr><th>Date</th><th>Reference</th><th>Claimant</th><th>Details</th><th>Status</th><th className="num">Amount</th><th /></tr>
          </thead>
          <tbody>
            {claims.map((c) => (
              <tr key={c.id}>
                <td>{c.date ? fmtDate(c.date) : '—'}</td>
                <td>{c.reference || '—'}</td>
                <td>{c.claimant || '—'}</td>
                <td className="muted">{c.narration || '—'}</td>
                <td><Badge status={c.status} label={c.status === 'PAID' ? 'Reimbursed' : c.status[0] + c.status.slice(1).toLowerCase()} /></td>
                <td className="num">{money(c.total)}</td>
                <td className="row-actions">
                  {c.status === 'DRAFT' && <button className="btn small" onClick={() => openEdit(c.id, setEditing)}>Edit</button>}
                  {c.status === 'DRAFT' && <button className="btn small primary" onClick={() => act(() => api('expenseclaims.approve', c.id), 'Claim approved')}>Approve</button>}
                  {c.status === 'DRAFT' && <button className="btn small danger" onClick={() => act(() => api('expenseclaims.remove', c.id), 'Draft deleted')}>Delete</button>}
                  {c.status === 'APPROVED' && <button className="btn small primary" onClick={() => setReimbursing(c)}>Reimburse</button>}
                  {c.status !== 'DRAFT' && <button className="btn small danger" onClick={() => act(() => api('expenseclaims.voidClaim', c.id), 'Claim voided')}>Void</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing && <ClaimEditor claim={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
      {reimbursing && <ReimburseModal claim={reimbursing} onClose={() => setReimbursing(null)} onDone={() => { setReimbursing(null); refresh(); }} />}
    </div>
  );
}

async function openEdit(id: number, setEditing: (c: any) => void) {
  const c = await api('expenseclaims.get', id);
  setEditing({
    id: c.id,
    date: c.date || todayIso(),
    reference: c.reference || '',
    narration: c.narration || '',
    line_amount_type: c.line_amount_type || 'INCLUSIVE',
    lines: (c.lines || []).map((l: any) => ({ account_id: l.account_id ?? '', description: l.description || '', amount: l.unit_rate != null ? String(fromCents(l.unit_rate)) : String(fromCents(l.amount)), tax_rate_id: l.tax_rate_id ?? null, project_id: l.project_id ?? null })),
  });
}

function ClaimEditor({ claim, onClose, onSaved }: { claim: any; onClose: () => void; onSaved: () => void }) {
  const [date, setDate] = useState<string>(claim.date);
  const [reference, setReference] = useState<string>(claim.reference || '');
  const [narration, setNarration] = useState<string>(claim.narration || '');
  const [mode, setMode] = useState<string>(claim.line_amount_type || 'INCLUSIVE');
  const [lines, setLines] = useState<LineDraft[]>(claim.lines?.length ? claim.lines : [blankLine()]);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const setLine = (i: number, patch: Partial<LineDraft>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const addLine = () => setLines((ls) => [...ls, blankLine()]);
  const removeLine = (i: number) => setLines((ls) => (ls.length > 1 ? ls.filter((_, j) => j !== i) : ls));

  const total = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);

  function build() {
    return {
      id: claim.id,
      date,
      reference: reference.trim() || undefined,
      narration: narration.trim() || undefined,
      line_amount_type: mode,
      lines: lines.filter((l) => l.account_id && Number(l.amount)).map((l) => ({ account_id: Number(l.account_id), description: l.description.trim() || undefined, unit_amount: toCents(l.amount), tax_rate_id: l.tax_rate_id, project_id: l.project_id ?? null })),
    };
  }

  async function save(approve: boolean) {
    if (dateError(date)) { toast('Enter a valid claim date'); return; }
    const payload = build();
    if (payload.lines.length === 0) { toast('Add at least one line with an account and amount'); return; }
    setBusy(true);
    try {
      const saved = await api('expenseclaims.save', payload);
      if (approve) await api('expenseclaims.approve', saved.id);
      toast(approve ? 'Claim approved' : 'Draft saved');
      onSaved();
    } catch (e: any) {
      toast(e.message || 'Could not save the claim');
    } finally { setBusy(false); }
  }

  return (
    <Modal title={claim.id ? 'Edit expense claim' : 'New expense claim'} onClose={onClose} wide>
      <div className="form-grid two">
        <Field label="Date"><DateField value={date} onChange={setDate} /></Field>
        <Field label="Reference (optional)"><input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. trip name, receipt batch" /></Field>
      </div>
      <Field label="Description (optional)"><input value={narration} onChange={(e) => setNarration(e.target.value)} placeholder="What was this claim for?" /></Field>
      <Field label="Amounts are">
        <select value={mode} onChange={(e) => setMode(e.target.value)} style={{ width: 220 }}>
          <option value="INCLUSIVE">Tax inclusive (receipt totals)</option>
          <option value="EXCLUSIVE">Tax exclusive (amounts before tax)</option>
          <option value="NOTAX">No tax</option>
        </select>
      </Field>

      <table className="tbl tight" style={{ marginTop: 8 }}>
        <thead><tr><th style={{ width: '30%' }}>Account</th><th>Description</th>{mode !== 'NOTAX' && <th style={{ width: 160 }}>Tax</th>}<th style={{ width: 150 }}>Project</th><th className="num" style={{ width: 120 }}>Amount</th><th /></tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td><PickAccount value={l.account_id} onChange={(id) => setLine(i, { account_id: id })} types={['EXPENSE', 'ASSET']} /></td>
              <td><input value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} placeholder="e.g. Taxi to airport" /></td>
              {mode !== 'NOTAX' && <td><PickTaxRate value={l.tax_rate_id} onChange={(id) => setLine(i, { tax_rate_id: id })} side="purchases" /></td>}
              <td><PickProject value={l.project_id} onChange={(pid) => setLine(i, { project_id: pid })} /></td>
              <td className="num"><input className="num" inputMode="decimal" value={l.amount} onChange={(e) => setLine(i, { amount: e.target.value })} placeholder="0.00" style={{ width: 100, textAlign: 'right' }} /></td>
              <td><button className="btn small ghost" title="Remove line" onClick={() => removeLine(i)}>✕</button></td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr><td colSpan={mode !== 'NOTAX' ? 4 : 3}><button className="btn small" onClick={addLine}>+ Add line</button></td><td className="num" style={{ fontWeight: 600 }}>{money(toCents(String(total)))}</td><td /></tr>
        </tfoot>
      </table>

      <div className="modal-actions">
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn" onClick={() => save(false)} disabled={busy}>Save draft</button>
        <button className="btn primary" onClick={() => save(true)} disabled={busy}>{claim.id ? 'Approve' : 'Save & approve'}</button>
      </div>
    </Modal>
  );
}

function ReimburseModal({ claim, onClose, onDone }: { claim: any; onClose: () => void; onDone: () => void }) {
  const { data: banks } = useApi<any[]>('banking.accounts');
  const [bankId, setBankId] = useState<number | ''>('');
  const [date, setDate] = useState<string>(todayIso());
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function go() {
    if (!bankId) { toast('Choose a bank account'); return; }
    if (dateError(date)) { toast('Enter a valid payment date'); return; }
    setBusy(true);
    try {
      await api('expenseclaims.reimburse', { claim_id: claim.id, bank_account_id: Number(bankId), date });
      toast('Claim reimbursed');
      onDone();
    } catch (e: any) { toast(e.message || 'Could not reimburse'); }
    finally { setBusy(false); }
  }

  return (
    <Modal title="Reimburse expense claim" onClose={onClose}>
      <p className="muted">Paying {money(claim.total)}{claim.reference ? ` for ${claim.reference}` : ''}{claim.claimant ? ` to ${claim.claimant}` : ''}.</p>
      <Field label="Pay from bank account">
        <select value={bankId} onChange={(e) => setBankId(e.target.value ? Number(e.target.value) : '')}>
          <option value="">Choose…</option>
          {(banks ?? []).map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </Field>
      <Field label="Payment date"><DateField value={date} onChange={setDate} /></Field>
      <div className="modal-actions">
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn primary" onClick={go} disabled={busy}>Reimburse {money(claim.total)}</button>
      </div>
    </Modal>
  );
}
