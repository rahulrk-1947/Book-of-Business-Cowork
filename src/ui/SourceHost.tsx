/**
 * SourceHost: mounted once in App. Any screen can call openSource(type, id)
 * — a report drill-down row, a GL line, an aged invoice — and the right
 * detail view opens: the full document viewer for invoices/bills/credits,
 * or a transaction modal (with the underlying journal) for payments, bank
 * transactions, transfers, depreciation runs and manual journals.
 */
import React, { useEffect, useState } from 'react';
import { api, money, fmtDate } from './api';
import { useApi, useToast, Modal, Badge, ErrorBanner, openSource, ConfirmDanger, DocHistory } from './components';
import { DocumentViewer } from './pages/DocumentEditor';
import { Attachments } from './Attachments';
import { nav } from './App';

type Source = { source_type: string; source_id: number };

export default function SourceHost() {
  const [stack, setStack] = useState<Source[]>([]);
  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent).detail as Source;
      if (d?.source_type && d?.source_id != null) setStack((s) => [...s, d]);
    };
    window.addEventListener('bob:open-source', h);
    return () => window.removeEventListener('bob:open-source', h);
  }, []);
  const top = stack[stack.length - 1];
  if (!top) return null;
  const close = () => setStack((s) => s.slice(0, -1));
  return <SourceView key={`${top.source_type}-${top.source_id}-${stack.length}`} src={top} onClose={close} />;
}

function SourceView({ src, onClose }: { src: Source; onClose: () => void }) {
  switch (src.source_type) {
    case 'INVOICE':
    case 'BILL':
      return <InvoiceSource id={src.source_id} onClose={onClose} />;
    case 'PAYMENT':
      return <PaymentSource id={src.source_id} onClose={onClose} />;
    case 'BANKTXN':
      return <BankTxnSource id={src.source_id} onClose={onClose} />;
    case 'MANUAL':
      return <ManualSource id={src.source_id} onClose={onClose} />;
    default:
      return <JournalSource src={src} onClose={onClose} />;
  }
}

// Invoices/bills/credit notes: the real document viewer (with all actions).
function InvoiceSource({ id, onClose }: { id: number; onClose: () => void }) {
  const { data: doc, error } = useApi<any>('invoices.get', id);
  if (error) return <Modal title="Document" onClose={onClose}><ErrorBanner msg={error} /></Modal>;
  if (!doc) return null;
  return <DocumentViewer kind={doc.type} docId={id} onClose={onClose} onChanged={() => {}} />;
}

function PaymentSource({ id, onClose }: { id: number; onClose: () => void }) {
  const { data: p, error } = useApi<any>('payments.get', id);
  const toast = useToast();
  const [err, setErr] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  if (error) return <Modal title="Payment" onClose={onClose}><ErrorBanner msg={error} /></Modal>;
  if (!p) return null;
  return (
    <Modal title={`Payment ${p.payment_number ?? `#${p.id}`}`} onClose={onClose}>
      <ErrorBanner msg={err} />
      <div className="kv" style={{ marginBottom: 12 }}>
        <span className="k">Type</span><span>{p.type === 'RECEIVE' ? 'Money received' : 'Money spent'}</span>
        <span className="k">Date</span><span>{fmtDate(p.date)}</span>
        <span className="k">Contact</span><span>{p.contact_name ?? '—'}</span>
        <span className="k">Bank account</span><span>{p.bank_name}</span>
        <span className="k">Amount</span><span><strong>{money(p.amount, p.currency_code)}</strong>{p.currency_code && p.exchange_rate !== 1 ? ` @ ${p.exchange_rate}` : ''}</span>
        {p.reference && <><span className="k">Reference</span><span>{p.reference}</span></>}
        <span className="k">Status</span><span><Badge status={p.status ?? 'POSTED'} /></span>
      </div>
      <h3>Applied to</h3>
      <table className="tbl">
        <thead><tr><th>Document</th><th className="num">Amount</th><th /></tr></thead>
        <tbody>
          {(p.allocations ?? []).map((a: any) => (
            <tr key={a.id}>
              <td className="mono small">{a.invoice_number}</td>
              <td className="num">{money(a.amount)}</td>
              <td className="num"><a onClick={() => openSource('INVOICE', a.invoice_id)}>Open</a></td>
            </tr>
          ))}
        </tbody>
      </table>
      <Attachments entityType="payment" entityId={p.id} />
      <p className="muted small">Payments aren't edited in place — deleting one reverses its journal, reopens the documents it paid, and un-reconciles any matched statement lines. You can then record it again correctly.</p>
      <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
        <button className="btn danger" onClick={() => setDeleting(true)}>Delete payment</button>
        <button className="btn" onClick={onClose}>Close</button>
      </div>
      {deleting && (
        <ConfirmDanger
          title="Delete this payment?"
          lines={[
            `${money(p.amount, p.currency_code)} ${p.type === 'RECEIVE' ? 'received into' : 'paid from'} ${p.bank_name} on ${fmtDate(p.date)}.`,
            'Its bank entry is reversed, so the bank balance updates.',
            'The documents it paid return to awaiting payment.',
            'Any statement line it was reconciled against becomes unreconciled.',
            'This can’t be undone — you can record the payment again afterwards.',
          ]}
          ack="I understand this reverses the payment and reopens the documents."
          confirmLabel="Delete payment"
          onConfirm={async () => { await api('payments.remove', p.id); toast('Payment deleted'); onClose(); }}
          onClose={() => setDeleting(false)}
        />
      )}
    </Modal>
  );
}

function BankTxnSource({ id, onClose }: { id: number; onClose: () => void }) {
  const { data: t, error } = useApi<any>('banking.getTransaction', id);
  const toast = useToast();
  const [err, setErr] = useState<string | null>(null);
  const [voiding, setVoiding] = useState(false);
  if (error) return <Modal title="Bank transaction" onClose={onClose}><ErrorBanner msg={error} /></Modal>;
  if (!t) return null;
  return (
    <Modal title={`${t.type === 'RECEIVE' ? 'Receive money' : 'Spend money'} — ${t.bank_name}`} onClose={onClose}>
      <ErrorBanner msg={err} />
      <div className="kv" style={{ marginBottom: 12 }}>
        <span className="k">Date</span><span>{fmtDate(t.date)}</span>
        <span className="k">Contact</span><span>{t.contact_name ?? '—'}</span>
        {t.reference && <><span className="k">Reference</span><span>{t.reference}</span></>}
        <span className="k">Total</span><span><strong>{money(t.total)}</strong></span>
        <span className="k">Status</span><span><Badge status={t.status} /></span>
      </div>
      <table className="tbl">
        <thead><tr><th>Account</th><th>Description</th><th className="num">Amount</th></tr></thead>
        <tbody>
          {(t.lines ?? []).map((l: any) => (
            <tr key={l.id}><td>{l.account_code} {l.account_name}</td><td>{l.description}</td><td className="num">{money(l.line_amount)}</td></tr>
          ))}
        </tbody>
      </table>
      <Attachments entityType="bank_transaction" entityId={t.id} />
      <DocHistory source="BANKTXN" docId={t.id} />
      <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
        {t.status === 'POSTED' && (
          <button className="btn danger" onClick={() => setVoiding(true)}>Void</button>
        )}
        <button className="btn" onClick={onClose}>Close</button>
      </div>
      {voiding && (
        <ConfirmDanger
          title="Void this bank transaction?"
          lines={[
            `${t.type === 'RECEIVE' ? 'Receive' : 'Spend'} money of ${money(t.total)} in ${t.bank_name} on ${fmtDate(t.date)}.`,
            'Its ledger entry is reversed, so the bank balance and reports update.',
            'Any statement line it was matched to becomes unreconciled.',
            'This can’t be undone — you can re-enter the transaction afterwards.',
          ]}
          ack="I understand this reverses the entry and can’t be undone."
          confirmLabel="Void transaction"
          onConfirm={async () => { await api('banking.voidBankTransaction', t.id); toast('Transaction voided'); onClose(); }}
          onClose={() => setVoiding(false)}
        />
      )}
    </Modal>
  );
}

function ManualSource({ id, onClose }: { id: number; onClose: () => void }) {
  const { data: j, error } = useApi<any>('journals.get', id);
  if (error) return <Modal title="Manual journal" onClose={onClose}><ErrorBanner msg={error} /></Modal>;
  if (!j) return null;
  return (
    <Modal title={`Manual journal — ${j.narration}`} onClose={onClose}>
      <div className="kv" style={{ marginBottom: 12 }}>
        <span className="k">Date</span><span>{fmtDate(j.date)}</span>
        <span className="k">Status</span><span><Badge status={j.status} /></span>
        {j.auto_reversing_date && <><span className="k">Auto-reverses</span><span>{fmtDate(j.auto_reversing_date)}</span></>}
      </div>
      <JournalLinesTable lines={j.lines} />
      <Attachments entityType="manual_journal" entityId={j.id} />
      <DocHistory source="MANUAL" docId={j.id} />
      <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
        <button className="btn" onClick={() => { onClose(); nav('journals'); }}>Open Manual journals</button>
        <button className="btn" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

const SOURCE_TITLES: Record<string, string> = {
  TRANSFER: 'Bank transfer', DEPRN: 'Depreciation run', DISPOSAL: 'Asset disposal',
};

function JournalSource({ src, onClose }: { src: Source; onClose: () => void }) {
  const { data: journals, error } = useApi<any[]>('journals.forSource', src.source_type, src.source_id);
  if (error) return <Modal title="Transaction" onClose={onClose}><ErrorBanner msg={error} /></Modal>;
  if (!journals) return null;
  return (
    <Modal title={SOURCE_TITLES[src.source_type] ?? `${src.source_type} #${src.source_id}`} onClose={onClose}>
      {journals.length === 0 && <p className="muted">No journal found for this transaction.</p>}
      {journals.map((j: any) => (
        <div key={j.id} style={{ marginBottom: 16 }}>
          <div className="kv" style={{ marginBottom: 8 }}>
            <span className="k">Journal</span><span className="mono small">{j.journal_number}</span>
            <span className="k">Date</span><span>{fmtDate(j.date)}</span>
            <span className="k">Status</span><span><Badge status={j.status} /></span>
            {j.narration && <><span className="k">Narration</span><span>{j.narration}</span></>}
          </div>
          <JournalLinesTable lines={j.lines} />
        </div>
      ))}
      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
        {src.source_type === 'DEPRN' || src.source_type === 'DISPOSAL' ? (
          <button className="btn" onClick={() => { onClose(); nav('assets'); }}>Open Fixed assets</button>
        ) : null}
        <button className="btn" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

function JournalLinesTable({ lines }: { lines: any[] }) {
  return (
    <table className="tbl">
      <thead><tr><th>Account</th><th>Description</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
      <tbody>
        {(lines ?? []).map((l: any) => (
          <tr key={l.id}>
            <td>{l.account_code} {l.account_name}</td>
            <td>
              {l.description ?? ''}
              {l.contact_name ? <span className="muted small"> · {l.contact_name}</span> : ''}
              {(l.tracking_1 || l.tracking_2) ? <span className="muted small"> · {[l.tracking_1, l.tracking_2].filter(Boolean).join(' · ')}</span> : ''}
            </td>
            <td className="num">{l.debit ? money(l.debit) : ''}</td>
            <td className="num">{l.credit ? money(l.credit) : ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
