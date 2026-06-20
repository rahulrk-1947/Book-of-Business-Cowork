import { useState } from 'react';
import { useApi, useToast, Modal, Field, Empty, Spinner, ErrorBanner, PickAccount, PickContact, DateField } from '../components';
import { api, money, toCents, todayIso, fmtDate, dateError } from '../api';

export default function Deferrals() {
  const { data: schedules, error, loading, reload } = useApi<any[]>('deferrals.list');
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  const toast = useToast();

  async function voidOne(id: number) {
    try { await api('deferrals.voidSchedule', id); toast('Schedule voided'); reload(); }
    catch (e: any) { toast(e.message || 'Could not void'); }
  }

  if (loading && schedules == null) return error ? <ErrorBanner msg={error} /> : <Spinner />;
  const rows = schedules ?? [];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Accruals &amp; deferrals</h1>
          <div className="muted small">Recognise deferred income or prepaid expenses over time.</div>
        </div>
        <button className="btn primary" onClick={() => setCreating(true)}>New schedule</button>
      </div>

      {error && <ErrorBanner msg={error} />}

      {rows.length === 0 ? (
        <Empty title="No deferral schedules yet." sub="Code an invoice or bill to a holding account (e.g. Deferred income or Prepaid expenses), then set up a schedule to recognise it over time." />
      ) : (
        <table className="tbl">
          <thead>
            <tr><th>Name</th><th>Type</th><th>Holding → Recognition</th><th>Start</th><th className="num">Months</th><th className="num">Total</th><th>Recognised</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const pct = s.total ? Math.round((s.recognised_to_date / s.total) * 100) : 0;
              return (
                <tr key={s.id}>
                  <td><a className="link" onClick={() => setViewing(s.id)}>{s.name || `Schedule #${s.id}`}</a></td>
                  <td>{s.kind === 'INCOME' ? 'Income' : 'Expense'}</td>
                  <td className="muted small">{s.deferral_code} {s.deferral_name} → {s.recognition_code} {s.recognition_name}</td>
                  <td>{fmtDate(s.start_date)}</td>
                  <td className="num">{s.periods}</td>
                  <td className="num">{money(s.total)}</td>
                  <td style={{ minWidth: 150 }}>
                    <div style={{ height: 8, background: 'var(--line, #e5e7eb)', borderRadius: 5, overflow: 'hidden' }}>
                      <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent, #2563eb)' }} />
                    </div>
                    <div className="muted small">{money(s.recognised_to_date)} of {money(s.total)} ({pct}%)</div>
                  </td>
                  <td><button className="btn small danger" onClick={() => voidOne(s.id)}>Void</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {creating && <ScheduleEditor onClose={() => setCreating(false)} onSaved={() => { setCreating(false); reload(); }} />}
      {viewing != null && <ScheduleDetail id={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

function ScheduleEditor({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [kind, setKind] = useState<'INCOME' | 'EXPENSE'>('INCOME');
  const [name, setName] = useState('');
  const [deferralAcct, setDeferralAcct] = useState<number | ''>('');
  const [recognitionAcct, setRecognitionAcct] = useState<number | ''>('');
  const [contact, setContact] = useState<number | ''>('');
  const [amount, setAmount] = useState('');
  const [periods, setPeriods] = useState('12');
  const [start, setStart] = useState(todayIso());
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function save() {
    if (!deferralAcct) { toast('Choose a holding account'); return; }
    if (!recognitionAcct) { toast(kind === 'INCOME' ? 'Choose an income account' : 'Choose an expense account'); return; }
    if (!Number(amount)) { toast('Enter an amount'); return; }
    if (!Number(periods) || Number(periods) < 1) { toast('Enter the number of months'); return; }
    if (dateError(start)) { toast('Enter a valid start date'); return; }
    setBusy(true);
    try {
      await api('deferrals.create', {
        name: name.trim() || undefined, kind,
        deferral_account_id: Number(deferralAcct), recognition_account_id: Number(recognitionAcct),
        contact_id: contact ? Number(contact) : undefined,
        total: toCents(amount), periods: Number(periods), start_date: start,
      });
      toast('Schedule created — recognition postings scheduled');
      onSaved();
    } catch (e: any) { toast(e.message || 'Could not create the schedule'); }
    finally { setBusy(false); }
  }

  const monthly = Number(amount) && Number(periods) ? Number(amount) / Number(periods) : 0;

  return (
    <Modal title="New deferral schedule" onClose={onClose} wide>
      <Field label="Type">
        <select value={kind} onChange={(e) => { setKind(e.target.value as any); setRecognitionAcct(''); setDeferralAcct(''); }} style={{ width: 260 }}>
          <option value="INCOME">Deferred income (recognise revenue over time)</option>
          <option value="EXPENSE">Prepaid expense (recognise expense over time)</option>
        </select>
      </Field>
      <Field label="Name (optional)"><input value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'INCOME' ? 'e.g. Annual subscription — Acme' : 'e.g. Annual insurance'} /></Field>
      <div className="form-grid two">
        <Field label={kind === 'INCOME' ? 'Holding account (a liability, e.g. Deferred income)' : 'Holding account (an asset, e.g. Prepaid expenses)'}>
          <PickAccount value={deferralAcct} onChange={(id) => setDeferralAcct(id)} types={kind === 'INCOME' ? ['LIABILITY', 'EQUITY', 'ASSET'] : ['ASSET', 'LIABILITY', 'EQUITY']} allowSystem />
        </Field>
        <Field label={kind === 'INCOME' ? 'Recognise to (income account)' : 'Recognise to (expense account)'}>
          <PickAccount value={recognitionAcct} onChange={(id) => setRecognitionAcct(id)} types={kind === 'INCOME' ? ['REVENUE'] : ['EXPENSE']} />
        </Field>
      </div>
      <div className="form-grid two">
        <Field label="Total amount"><input className="num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" style={{ textAlign: 'right' }} /></Field>
        <Field label="Number of months"><input className="num" inputMode="numeric" value={periods} onChange={(e) => setPeriods(e.target.value)} style={{ width: 100, textAlign: 'right' }} /></Field>
      </div>
      <div className="form-grid two">
        <Field label="First period date"><DateField value={start} onChange={setStart} /></Field>
        <Field label="Customer / supplier (optional)"><PickContact value={contact} onChange={(id) => setContact(id)} /></Field>
      </div>
      {monthly > 0 && <div className="muted small">≈ {money(toCents(String(monthly)))} recognised each month (the last month absorbs any rounding).</div>}
      <div className="muted small" style={{ marginTop: 4 }}>The amount should already sit in the holding account — code the originating invoice or bill to it, then this schedule moves it into {kind === 'INCOME' ? 'income' : 'expense'} month by month.</div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={busy}>Create schedule</button>
      </div>
    </Modal>
  );
}

function ScheduleDetail({ id, onClose }: { id: number; onClose: () => void }) {
  const { data: s, error, loading } = useApi<any>('deferrals.get', id);
  return (
    <Modal title={s?.name || 'Deferral schedule'} onClose={onClose}>
      {loading && s == null ? <Spinner /> : error ? <ErrorBanner msg={error} /> : (
        <>
          <div className="muted small" style={{ marginBottom: 8 }}>
            {s.kind === 'INCOME' ? 'Income' : 'Expense'} · {money(s.total)} over {(s.periods || []).length} months · recognised {money(s.recognised_to_date)}, remaining {money(s.remaining)}
          </div>
          <table className="tbl tight">
            <thead><tr><th>Period</th><th>Date</th><th className="num">Amount</th><th>Status</th></tr></thead>
            <tbody>
              {(s.periods || []).map((p: any, i: number) => (
                <tr key={i}><td>{i + 1}</td><td>{fmtDate(p.date)}</td><td className="num">{money(p.amount)}</td><td>{p.recognised ? 'Recognised' : 'Upcoming'}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Modal>
  );
}
