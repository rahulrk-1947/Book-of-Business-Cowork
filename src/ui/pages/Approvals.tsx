import React, { useState } from 'react';
import { useApi, useToast, Money, Empty, Modal, Field, ErrorBanner, NumberField } from '../components';
import { api, toCents, fromCents, fmtDate } from '../api';

const DOC_LABEL: Record<string, string> = { ACCREC: 'Invoices', ACCPAY: 'Bills' };

export default function Approvals() {
  const { data: pending, reload } = useApi<any[]>('approvals.listPending');
  const { data: rules, reload: reloadRules } = useApi<any[]>('approvals.listRules');
  const toast = useToast();
  const [rule, setRule] = useState<any | null>(null);
  const [reject, setReject] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);

  async function act(fn: () => Promise<any>, msg: string) {
    setBusy(true);
    try { await fn(); toast(msg); reload(); reloadRules(); } catch (e: any) { toast(e.message); } finally { setBusy(false); }
  }

  return (
    <>
      <div className="page-head">
        <h1>Approvals</h1>
        <span className="grow" />
        <button className="btn small" onClick={() => setRule({})}>+ Approval rule</button>
      </div>

      <div className="card tight">
        <h3 style={{ margin: '4px 0 10px' }}>Waiting for approval</h3>
        {!pending || pending.length === 0 ? (
          <Empty title="Nothing waiting" sub="Documents submitted for approval show up here for sign-off." />
        ) : (
          <table className="tbl">
            <thead><tr><th>Type</th><th>Number</th><th>Contact</th><th>Date</th><th className="num">Amount</th><th></th></tr></thead>
            <tbody>
              {pending.map((p) => (
                <tr key={p.id}>
                  <td>{p.doc_type === 'ACCPAY' ? 'Bill' : 'Invoice'}</td>
                  <td>{p.invoice_number ?? <span className="muted">draft</span>}</td>
                  <td>{p.contact_name ?? <span className="muted">—</span>}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(p.date)}</td>
                  <td className="num"><Money cents={p.total} currency={p.currency_code} /></td>
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn small primary" disabled={busy} onClick={() => act(() => api('approvals.approve', p.doc_id), 'Approved and posted')}>Approve</button>
                    <button className="btn small danger" disabled={busy} style={{ marginLeft: 6 }} onClick={() => setReject(p)}>Reject</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="btn-row" style={{ alignItems: 'center', marginBottom: 8 }}>
          <h3 style={{ margin: 0, flex: 1 }}>Rules</h3>
          <button className="btn small" onClick={() => setRule({})}>+ Add rule</button>
        </div>
        <p className="muted small" style={{ marginTop: 0 }}>When a document’s total reaches the threshold, it must be submitted and approved before it can be posted.</p>
        {!rules || rules.length === 0 ? (
          <div className="muted small">No rules — invoices and bills post without approval.</div>
        ) : (
          <table className="tbl">
            <thead><tr><th>Applies to</th><th>Approval required at or above</th><th></th><th></th></tr></thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id}>
                  <td>{DOC_LABEL[r.doc_type] ?? r.doc_type}</td>
                  <td><Money cents={r.min_amount} /></td>
                  <td>{r.enabled ? <span className="badge green">on</span> : <span className="badge">off</span>}</td>
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn small" disabled={busy} onClick={() => act(() => api('approvals.setRuleEnabled', r.id, !r.enabled), r.enabled ? 'Turned off' : 'Turned on')}>{r.enabled ? 'Turn off' : 'Turn on'}</button>
                    <button className="btn small" disabled={busy} style={{ marginLeft: 6 }} onClick={() => setRule(r)}>Edit</button>
                    <button className="btn small danger" disabled={busy} style={{ marginLeft: 6 }} onClick={() => act(() => api('approvals.removeRule', r.id), 'Removed')}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {rule && <RuleModal rule={rule} onClose={() => setRule(null)} onSaved={() => { setRule(null); reloadRules(); }} />}
      {reject && <RejectModal item={reject} onClose={() => setReject(null)} onDone={() => { setReject(null); reload(); }} />}
    </>
  );
}

function RuleModal({ rule, onClose, onSaved }: { rule: any; onClose: () => void; onSaved: () => void }) {
  const [docType, setDocType] = useState(rule.doc_type ?? 'ACCPAY');
  const [threshold, setThreshold] = useState(rule.min_amount != null ? String(fromCents(rule.min_amount)) : '0');
  const [enabled, setEnabled] = useState(rule.enabled === undefined ? true : !!rule.enabled);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    setBusy(true); setErr(null);
    try { await api('approvals.saveRule', { id: rule.id, doc_type: docType, min_amount: threshold ? toCents(threshold) : 0, enabled }); onSaved(); }
    catch (e: any) { setErr(e.message); setBusy(false); }
  }
  return (
    <Modal title={rule.id ? 'Edit rule' : 'New approval rule'} onClose={onClose}>
      {err && <ErrorBanner msg={err} />}
      <div className="form-row">
        <Field label="Applies to"><select value={docType} onChange={(e) => setDocType(e.target.value)}><option value="ACCPAY">Bills</option><option value="ACCREC">Invoices</option></select></Field>
        <Field label="Require approval at or above"><NumberField value={threshold} onChange={setThreshold} label="amount" allowNegative={false} min={0} /></Field>
      </div>
      <label className="check" style={{ marginTop: 10 }}><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Active</label>
      <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={save}>Save rule</button>
      </div>
    </Modal>
  );
}

function RejectModal({ item, onClose, onDone }: { item: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  async function reject() {
    setBusy(true);
    try { await api('approvals.reject', item.doc_id, note || undefined); toast('Sent back to draft'); onDone(); }
    catch (e: any) { toast(e.message); setBusy(false); }
  }
  return (
    <Modal title="Reject document" onClose={onClose}>
      <p className="muted small">This sends {item.invoice_number ?? 'the document'} back to draft so it can be corrected and resubmitted.</p>
      <Field label="Reason (optional)"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. missing purchase order" autoFocus /></Field>
      <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn danger" disabled={busy} onClick={reject}>Reject</button>
      </div>
    </Modal>
  );
}
