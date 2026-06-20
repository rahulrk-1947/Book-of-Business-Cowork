import React, { useState } from 'react';
import { useApi, useToast, Money, Badge, Empty, Tabs, Modal, Field, ErrorBanner } from '../components';
import { DateField } from '../components';
import { api, fmtDate, todayIso, money } from '../api';
import { DocumentEditor, DocumentViewer } from './DocumentEditor';
import { DocList } from './Sales';

export default function Purchases() {
  const [tab, setTab] = useState('bills');
  return (
    <>
      <div className="page-head"><h1>Purchases</h1></div>
      <Tabs
        tabs={[
          { id: 'bills', label: 'Bills' },
          { id: 'pos', label: 'Purchase orders' },
          { id: 'credits', label: 'Supplier credits' },
          { id: 'batch', label: 'Batch pay' },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'bills' && <DocList kind="ACCPAY" newLabel="New bill" />}
      {tab === 'pos' && <POList />}
      {tab === 'credits' && <DocList kind="ACCPAYCREDIT" newLabel="New supplier credit" />}
      {tab === 'batch' && <BatchPay />}
    </>
  );
}

function POList() {
  const { data, reload } = useApi<any[]>('invoices.listPOs');
  const [editing, setEditing] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  return (
    <>
      <div className="page-head">
        <div className="grow" />
        <button className="btn primary" onClick={() => setEditing(true)}>+ New purchase order</button>
      </div>
      <div className="card tight">
        {data && data.length === 0 ? (
          <Empty title="No purchase orders" />
        ) : (
          <table className="tbl">
            <thead><tr><th>Number</th><th>Supplier</th><th>Date</th><th>Delivery</th><th>Status</th><th className="num">Total</th></tr></thead>
            <tbody>
              {(data ?? []).map((p) => (
                <tr key={p.id} className="click" onClick={() => setViewing(p.id)}>
                  <td><strong>{p.order_number}</strong>{p.reference && <div className="faint small">{p.reference}</div>}</td>
                  <td>{p.contact_name}</td>
                  <td>{fmtDate(p.date)}</td>
                  <td>{fmtDate(p.delivery_date)}</td>
                  <td><Badge status={p.status} /></td>
                  <td className="num"><Money cents={p.total} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editing && <DocumentEditor kind="PO" onClose={() => setEditing(false)} onSaved={() => { setEditing(false); reload(); }} />}
      {viewing != null && <DocumentViewer kind="PO" docId={viewing} onClose={() => setViewing(null)} onChanged={reload} />}
    </>
  );
}

function BatchPay() {
  const { data: bills, reload } = useApi<any[]>('invoices.list', { type: 'ACCPAY', status: 'AUTHORISED' });
  const { data: banks } = useApi<any[]>('banking.accounts');
  const toast = useToast();
  const [picked, setPicked] = useState<Record<number, boolean>>({});
  const [confirming, setConfirming] = useState(false);
  const [bank, setBank] = useState<number | ''>('');
  const [date, setDate] = useState(todayIso());
  const [err, setErr] = useState<string | null>(null);

  const open = (bills ?? []).filter((b) => b.amount_due > 0);
  const selected = open.filter((b) => picked[b.id]);
  const total = selected.reduce((s, b) => s + b.amount_due, 0);

  async function run() {
    setErr(null);
    try {
      await api('payments.batchPay', {
        date, bank_account_id: bank || (banks?.[0]?.id ?? 0),
        reference: `Batch payment ${date}`,
        bills: selected.map((b) => ({ invoice_id: b.id, amount: b.amount_due })),
      });
      toast(`Paid ${selected.length} bills — ${money(total)}`);
      setPicked({});
      setConfirming(false);
      reload();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  return (
    <>
      <ErrorBanner msg={err} />
      <div className="page-head">
        <span className="muted">{selected.length} selected — {money(total)}</span>
        <div className="grow" />
        <button className="btn primary" disabled={!selected.length} onClick={() => setConfirming(true)}>Pay selected bills</button>
      </div>
      <div className="card tight">
        {open.length === 0 ? (
          <Empty title="No bills awaiting payment" />
        ) : (
          <table className="tbl">
            <thead><tr><th style={{ width: 34 }} /><th>Number</th><th>Supplier</th><th>Due</th><th className="num">Amount due</th></tr></thead>
            <tbody>
              {open.map((b) => (
                <tr key={b.id}>
                  <td><input type="checkbox" style={{ width: 'auto' }} checked={!!picked[b.id]} onChange={(e) => setPicked((p) => ({ ...p, [b.id]: e.target.checked }))} /></td>
                  <td><strong>{b.invoice_number}</strong></td>
                  <td>{b.contact_name}</td>
                  <td>{fmtDate(b.due_date)}</td>
                  <td className="num"><Money cents={b.amount_due} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {confirming && (
        <Modal title="Confirm batch payment" onClose={() => setConfirming(false)}>
          <div className="form-row">
            <Field label="Pay from">
              <select value={bank} onChange={(e) => setBank(Number(e.target.value))}>
                {(banks ?? []).map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </Field>
            <Field label="Date"><DateField value={date} onChange={setDate} /></Field>
          </div>
          <p className="muted">{selected.length} bills · total {money(total)}</p>
          <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setConfirming(false)}>Cancel</button>
            <button className="btn primary" onClick={run}>Pay {money(total)}</button>
          </div>
        </Modal>
      )}
    </>
  );
}
