import React from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, CartesianGrid } from 'recharts';
import { useApi, Money, Spinner, ErrorBanner } from '../components';
import { money, fmtDate } from '../api';
import { nav } from '../App';

export default function Dashboard() {
  const { data, error, loading } = useApi<any>('dashboard.summary');
  const { data: setup } = useApi<any>('dashboard.setupStatus');
  if (loading) return <Spinner />;
  if (error) return <ErrorBanner msg={error} />;
  const d = data!;
  const chart = d.cash_by_month.map((m: any) => ({
    month: new Date(m.month + '-01T00:00:00').toLocaleDateString('en-US', { month: 'short' }),
    'Cash in': m.cash_in / 100,
    'Cash out': m.cash_out / 100,
  }));
  const draftTotal = Object.values(d.drafts ?? {}).reduce((s: number, n: any) => s + Number(n), 0);
  const saleDrafts = (d.drafts?.ACCREC ?? 0) + (d.drafts?.ACCRECCREDIT ?? 0);
  const billDrafts = (d.drafts?.ACCPAY ?? 0) + (d.drafts?.ACCPAYCREDIT ?? 0);

  return (
    <>
      <div className="page-head">
        <h1>Dashboard</h1>
        {d?.ledger_balanced != null && (
          d.ledger_balanced
            ? <span className="badge green" title="Every posted journal balances: total debits equal total credits across the whole ledger.">Ledger balanced ✓</span>
            : <span className="badge red">Ledger out of balance — restore a backup</span>
        )}
      </div>

      {setup && !setup.complete && <SetupChecklist setup={setup} />}

      {draftTotal > 0 && (
        <div className="info-bar" onClick={() => nav(saleDrafts >= billDrafts ? 'sales' : 'purchases')} style={{ cursor: 'pointer' }}>
          ✎ You have <strong>{draftTotal}</strong> draft{draftTotal === 1 ? '' : 's'} awaiting approval
          {saleDrafts > 0 && billDrafts > 0 ? ` (${saleDrafts} sales, ${billDrafts} purchases)` : ''}. Approve them to post to your accounts.
        </div>
      )}

      <div className="grid cols-4">
        <div className="card stat">
          <div className="label">Total cash</div>
          <div className="value">{money(d.total_cash)}</div>
          <div className="sub">{d.banks.length} bank account{d.banks.length === 1 ? '' : 's'}</div>
        </div>
        <div className="card stat" style={{ cursor: 'pointer' }} onClick={() => nav('sales')}>
          <div className="label">Owed to you</div>
          <div className="value">{money(d.receivables.total)}</div>
          <div className="sub">{d.receivables.count} open invoices · <span style={{ color: d.receivables.overdue > 0 ? 'var(--red)' : undefined }}>{money(d.receivables.overdue)} overdue</span></div>
        </div>
        <div className="card stat" style={{ cursor: 'pointer' }} onClick={() => nav('purchases')}>
          <div className="label">You owe</div>
          <div className="value">{money(d.payables.total)}</div>
          <div className="sub">{d.payables.count} open bills · <span style={{ color: d.payables.overdue > 0 ? 'var(--red)' : undefined }}>{money(d.payables.overdue)} overdue</span></div>
        </div>
        <div className="card stat">
          <div className="label">Profit this month</div>
          <div className={`value ${d.pl_month.net >= 0 ? 'pos' : 'neg'}`}>{money(d.pl_month.net)}</div>
          <div className="sub">FY to date: {money(d.pl_fy.net)}</div>
        </div>
      </div>

      <div className="grid cols-2" style={{ marginTop: 18 }}>
        <div className="card">
          <h2>Cash in and out</h2>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={chart} barGap={3}>
              <CartesianGrid vertical={false} stroke="var(--line)" />
              <XAxis dataKey="month" tickLine={false} axisLine={false} fontSize={12} />
              <YAxis tickLine={false} axisLine={false} fontSize={12} tickFormatter={(v: number) => `$${v >= 1000 ? (v / 1000).toFixed(0) + 'k' : v}`} />
              <Tooltip formatter={(v: any) => money(Math.round(Number(v) * 100))} />
              <Legend iconType="circle" iconSize={9} />
              <Bar dataKey="Cash in" fill="#0078c8" radius={[3, 3, 0, 0]} />
              <Bar dataKey="Cash out" fill="#9aa5b1" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="card tight">
          <table className="tbl">
            <thead>
              <tr><th>Bank account</th><th className="num">Balance</th><th className="num">To reconcile</th></tr>
            </thead>
            <tbody>
              {d.banks.map((b: any) => (
                <tr key={b.id} className="click" onClick={() => nav(`bank/${b.id}`)}>
                  <td><strong>{b.name}</strong><div className="faint small">{b.code}</div></td>
                  <td className="num"><Money cents={b.balance} /></td>
                  <td className="num">{b.unreconciled > 0 ? <span className="badge amber">{b.unreconciled} items</span> : <span className="badge green">done</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ padding: 16 }}>
            <h3 style={{ marginBottom: 10 }}>Recent activity</h3>
            {d.recent_activity.slice(0, 6).map((a: any) => (
              <div key={a.id} className="small muted" style={{ padding: '3px 0' }}>
                <span className="mono faint">{(a.created_at ?? '').slice(0, 10)}</span> · {a.entity_type} {a.action.toLowerCase()}
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function SetupChecklist({ setup }: { setup: any }) {
  return (
    <div className="card setup-card">
      <div className="setup-head">
        <h2>Get started</h2>
        <span className="muted small">{setup.done_count} of {setup.total} done</span>
      </div>
      <div className="setup-progress"><div className="setup-progress-fill" style={{ width: `${(setup.done_count / setup.total) * 100}%` }} /></div>
      <div className="setup-steps">
        {setup.steps.map((s: any) => (
          <button key={s.id} className={`setup-step${s.done ? ' done' : ''}`} onClick={() => nav(s.nav)} disabled={s.done}>
            <span className="setup-check">{s.done ? '✓' : '○'}</span>
            <span className="setup-step-body">
              <span className="setup-step-label">{s.label}{s.optional && !s.done ? ' · optional' : ''}</span>
              {!s.done && <span className="setup-step-hint">{s.hint}</span>}
            </span>
            {!s.done && <span className="setup-step-go">→</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
