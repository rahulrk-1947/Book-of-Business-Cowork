import { useState } from 'react';
import { useApi, useToast, Modal, Field, Empty, Spinner, ErrorBanner } from '../components';
import { api, money, fmtDate } from '../api';

const LEVEL_COLOR: Record<string, string> = { 'Reminder': '#2563eb', 'Second notice': '#d97706', 'Final notice': '#b91c1c' };

export default function PaymentReminders() {
  const { data, error, loading, reload } = useApi<any>('reminders.list', {});
  const [composing, setComposing] = useState<any | null>(null);
  const toast = useToast();

  if (loading && data == null) return error ? <ErrorBanner msg={error} /> : <Spinner />;
  const customers: any[] = data?.customers ?? [];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Payment reminders</h1>
          <div className="muted small">Customers with overdue invoices.{data && data.totals.total_overdue > 0 ? ` ${money(data.totals.total_overdue)} overdue across ${data.totals.customers} customer${data.totals.customers === 1 ? '' : 's'}.` : ''}</div>
        </div>
      </div>

      {error && <ErrorBanner msg={error} />}

      {customers.length === 0 ? (
        <Empty title="Nothing overdue — every customer is up to date." />
      ) : (
        <table className="tbl">
          <thead>
            <tr><th>Customer</th><th>Level</th><th className="num">Invoices</th><th className="num">Overdue</th><th className="num">Oldest (days)</th><th>Last reminded</th><th /></tr>
          </thead>
          <tbody>
            {customers.map((c) => (
              <tr key={c.contact_id}>
                <td>
                  <div>{c.name}</div>
                  <div className="muted small">{c.email || 'No email on file'}</div>
                </td>
                <td><span style={{ color: LEVEL_COLOR[c.level] || 'inherit', fontWeight: 600 }}>{c.level}</span></td>
                <td className="num">{c.invoice_count}</td>
                <td className="num">{money(c.total_overdue)}</td>
                <td className="num">{c.oldest_days_overdue}</td>
                <td className="muted">{c.last_reminded_at ? `${c.last_reminded_days === 0 ? 'today' : `${c.last_reminded_days}d ago`}` : 'Never'}</td>
                <td><button className="btn small primary" onClick={() => setComposing(c)}>Send reminder</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {composing && <ReminderDialog customer={composing} onClose={() => setComposing(null)} onSent={() => { setComposing(null); reload(); }} />}
    </div>
  );
}

function ReminderDialog({ customer, onClose, onSent }: { customer: any; onClose: () => void; onSent: () => void }) {
  const { data: preview, error, loading } = useApi<any>('reminders.preview', { contact_id: customer.contact_id });
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [ready, setReady] = useState(false);
  const toast = useToast();

  // Seed the editable fields once the composed preview arrives.
  if (preview && !ready) { setTo(preview.to || ''); setSubject(preview.subject); setBody(preview.body); setReady(true); }

  async function markSent() {
    try { await api('reminders.recordSent', { contact_id: customer.contact_id, level: customer.level, amount: customer.total_overdue }); }
    catch { /* logging is best-effort */ }
  }

  async function openInMail() {
    const href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    try { window.location.href = href; } catch { /* ignore */ }
    await markSent();
    toast('Reminder opened in your email app and logged');
    onSent();
  }

  async function copy() {
    try { await navigator.clipboard.writeText(`Subject: ${subject}\n\n${body}`); toast('Reminder copied to clipboard'); }
    catch { toast('Could not copy — select the text manually'); }
  }

  return (
    <Modal title={`Reminder — ${customer.name}`} onClose={onClose} wide>
      {loading && preview == null ? <Spinner /> : error ? <ErrorBanner msg={error} /> : (
        <>
          {!customer.has_email && <div className="muted small" style={{ marginBottom: 8 }}>This customer has no email on file — copy the message below, or add an email on their contact record.</div>}
          <Field label="To"><input value={to} onChange={(e) => setTo(e.target.value)} placeholder="customer@email.com" /></Field>
          <Field label="Subject"><input value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>
          <Field label="Message"><textarea value={body} onChange={(e) => setBody(e.target.value)} rows={12} style={{ width: '100%', fontFamily: 'inherit' }} /></Field>
          <div className="muted small">Tip: edit the default wording under Settings → Email templates → Payment reminder.</div>
          <div className="modal-actions">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn" onClick={copy}>Copy</button>
            <button className="btn" onClick={markSent}>Mark as reminded</button>
            <button className="btn primary" onClick={openInMail} disabled={!to}>Open in email app</button>
          </div>
        </>
      )}
    </Modal>
  );
}
