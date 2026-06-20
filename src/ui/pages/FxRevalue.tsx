import React, { useState, useEffect } from 'react';
import { useApi, useToast, Money, Empty, ErrorBanner, Spinner } from '../components';
import { DateField } from '../components';
import { api, fmtDate, todayIso } from '../api';

export default function FxRevalue() {
  const toast = useToast();
  const [asOf, setAsOf] = useState(todayIso());
  const { data: currencies, loading } = useApi<string[]>('fxrevalue.openForeignCurrencies', asOf);
  const [rates, setRates] = useState<Record<string, string>>({});
  const [pv, setPv] = useState<any | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<any | null>(null);

  // Reset preview when inputs change.
  useEffect(() => { setPv(null); setDone(null); }, [asOf, JSON.stringify(rates)]);

  const list = currencies ?? [];
  const ratesNumeric = () => Object.fromEntries(list.map((c) => [c, parseFloat(rates[c] || '0')]));

  async function doPreview() {
    setErr(null);
    try { setPv(await api('fxrevalue.preview', asOf, ratesNumeric())); }
    catch (e: any) { setErr(e.message); }
  }
  async function doPost() {
    setErr(null); setBusy(true);
    try {
      const r = await api('fxrevalue.revalue', asOf, ratesNumeric());
      setDone(r);
      toast(r.posted ? 'Revaluation posted (auto-reverses next day)' : (r.message || 'Nothing to revalue'));
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <>
      <div className="page-head"><h1>Currency revaluation</h1></div>

      <div className="card" style={{ maxWidth: 760 }}>
        <p className="muted">
          Restate your <strong>open foreign-currency invoices and bills</strong> to the exchange rates at a chosen date.
          The difference is posted as an <strong>unrealised</strong> gain or loss and automatically reversed the next day —
          the real gain/loss is recognised when each document is actually paid.
        </p>
        <ErrorBanner msg={err} />
        <div className="form-row" style={{ alignItems: 'flex-end' }}>
          <label className="filter-field">
            <span className="filter-label">Revaluation date</span>
            <DateField value={asOf} onChange={setAsOf} />
          </label>
        </div>

        {loading ? <Spinner /> : list.length === 0 ? (
          <Empty title="No open foreign balances" sub="There are no unpaid invoices or bills in a foreign currency as at this date, so there's nothing to revalue." />
        ) : (
          <>
            <h3 style={{ margin: '14px 0 8px' }}>Closing rates</h3>
            <p className="muted small">Enter how many {pvBase(pv)} each foreign unit is worth on the revaluation date (e.g. 1 EUR = 1.20).</p>
            <table className="tbl" style={{ maxWidth: 420 }}>
              <thead><tr><th>Currency</th><th className="num">1 unit =</th></tr></thead>
              <tbody>
                {list.map((c) => (
                  <tr key={c}>
                    <td><strong>{c}</strong></td>
                    <td className="num"><input className="num" style={{ width: 120 }} type="number" step="0.0001" value={rates[c] ?? ''} placeholder="0.0000" onChange={(e) => setRates((r) => ({ ...r, [c]: e.target.value }))} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="btn-row" style={{ marginTop: 12 }}>
              <button className="btn" onClick={doPreview}>Preview</button>
              <button className="btn primary" disabled={busy} onClick={doPost}>Post revaluation</button>
            </div>
          </>
        )}
      </div>

      {pv && !done && <PreviewCard pv={pv} />}
      {done && (
        <div className="card" style={{ maxWidth: 760, marginTop: 16 }}>
          {done.posted ? (
            <div className="ok-banner">
              Posted an unrealised FX {done.total_gain >= 0 ? 'gain' : 'loss'} of <strong><Money cents={Math.abs(done.total_gain)} /></strong> as
              at {fmtDate(asOf)}, and a reversing entry the next day. You can see both in the General Ledger.
            </div>
          ) : (
            <div className="info-bar">{done.message}</div>
          )}
        </div>
      )}
    </>
  );
}

function pvBase(pv: any): string { return pv?.base || 'base-currency units'; }

function PreviewCard({ pv }: { pv: any }) {
  if (!pv.lines?.length) return <div className="card" style={{ maxWidth: 760, marginTop: 16 }}><Empty title="Nothing to revalue at these rates" /></div>;
  return (
    <div className="card tight" style={{ maxWidth: 760, marginTop: 16 }}>
      <h2 style={{ padding: '0 0 6px' }}>Preview — as at {fmtDate(pv.as_of)}</h2>
      <table className="tbl">
        <thead><tr><th>Currency</th><th>Ledger</th><th className="num">Open (foreign)</th><th className="num">Carried ({pv.base})</th><th className="num">Closing rate</th><th className="num">Revalued</th><th className="num">Adjustment</th></tr></thead>
        <tbody>
          {pv.lines.map((l: any, i: number) => (
            <tr key={i}>
              <td><strong>{l.currency}</strong></td>
              <td>{l.control === 'AR' ? 'Receivables' : 'Payables'}</td>
              <td className="num">{(l.open_foreign / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
              <td className="num"><Money cents={l.carrying_base} /></td>
              <td className="num">{l.closing_rate}</td>
              <td className="num"><Money cents={l.revalued_base} /></td>
              <td className="num" style={{ color: l.delta === 0 ? undefined : (l.delta > 0 ? 'var(--green)' : 'var(--red)') }}><Money cents={l.delta} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small" style={{ marginTop: 8 }}>
        Net unrealised {pv.total_gain >= 0 ? 'gain' : 'loss'}: <strong><Money cents={Math.abs(pv.total_gain)} /></strong>.
        Posting creates this entry on {fmtDate(pv.as_of)} and reverses it the next day.
      </p>
    </div>
  );
}
