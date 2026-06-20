import React, { useState } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts';
import { useApi, Money, Spinner, ErrorBanner, Empty, openSource } from '../components';
import { money, fmtDate } from '../api';

const PRESETS: Array<{ days: number; label: string }> = [
  { days: 30, label: '30 days' },
  { days: 60, label: '60 days' },
  { days: 90, label: '90 days' },
];

export default function Forecast() {
  const [horizon, setHorizon] = useState(90);
  const [custom, setCustom] = useState('');
  const effHorizon = custom && Number(custom) > 0 ? Number(custom) : horizon;
  const { data, error, loading } = useApi<any>('forecast.cashFlow', { horizon_days: effHorizon });

  return (
    <>
      <div className="page-head">
        <h1>Cash flow forecast</h1>
        <div className="grow" />
        <div className="seg">
          {PRESETS.map((p) => (
            <button key={p.days} className={`seg-btn${!custom && horizon === p.days ? ' active' : ''}`} onClick={() => { setCustom(''); setHorizon(p.days); }}>{p.label}</button>
          ))}
          <input className="seg-input" type="number" min="7" max="730" placeholder="custom" value={custom} onChange={(e) => setCustom(e.target.value)} title="Custom number of days" />
        </div>
      </div>

      {error && <ErrorBanner msg={error} />}
      {loading || data == null ? <Spinner /> : <ForecastView d={data} />}
    </>
  );
}

function ForecastView({ d }: { d: any }) {
  const negative = !!d.first_negative_date;
  const chart = d.weeks.map((w: any) => ({
    week: new Date(w.week_start + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    balance: w.balance / 100,
  }));

  return (
    <>
      {negative ? (
        <div className="warn-bar">
          ⚠ Heads up: at this rate your projected cash dips below zero around <strong>{fmtDate(d.first_negative_date)}</strong> (down to <Money cents={d.lowest_balance} />).
          Consider chasing overdue invoices or rescheduling a payment.
        </div>
      ) : (
        <div className="ok-banner" style={{ marginBottom: 16 }}>
          Your projected cash stays positive over the next {d.horizon_days} days. Lowest point: <strong><Money cents={d.lowest_balance} /></strong> around {fmtDate(d.lowest_date)}.
        </div>
      )}

      <div className="grid cols-4">
        <div className="card stat">
          <div className="label">Cash now</div>
          <div className="value"><Money cents={d.opening} /></div>
          <div className="sub">across your bank accounts</div>
        </div>
        <div className="card stat">
          <div className="label">Expected in</div>
          <div className="value pos"><Money cents={d.total_in} /></div>
          <div className="sub">next {d.horizon_days} days</div>
        </div>
        <div className="card stat">
          <div className="label">Expected out</div>
          <div className="value neg"><Money cents={d.total_out} /></div>
          <div className="sub">next {d.horizon_days} days</div>
        </div>
        <div className="card stat">
          <div className="label">Projected balance</div>
          <div className={`value ${d.projected_closing >= 0 ? 'pos' : 'neg'}`}><Money cents={d.projected_closing} /></div>
          <div className="sub">on {fmtDate(d.end)}</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <h2>Projected cash balance</h2>
        <ResponsiveContainer width="100%" height={260}>
          <AreaChart data={chart} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
            <defs>
              <linearGradient id="bal" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#0078c8" stopOpacity={0.28} />
                <stop offset="100%" stopColor="#0078c8" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="var(--line)" />
            <XAxis dataKey="week" tickLine={false} axisLine={false} fontSize={12} interval="preserveStartEnd" />
            <YAxis tickLine={false} axisLine={false} fontSize={12} tickFormatter={(v: number) => `$${Math.abs(v) >= 1000 ? (v / 1000).toFixed(0) + 'k' : v}`} />
            <Tooltip formatter={(v: any) => money(Math.round(Number(v) * 100))} />
            <ReferenceLine y={0} stroke="var(--red)" strokeDasharray="3 3" />
            <Area type="monotone" dataKey="balance" stroke="#0078c8" strokeWidth={2} fill="url(#bal)" />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="card tight" style={{ marginTop: 18 }}>
        {d.movements.length === 0 ? (
          <Empty title="Nothing expected in this window" sub="No outstanding invoices or bills fall due, and no recurring documents are scheduled, within this horizon." />
        ) : (
          <table className="tbl">
            <thead><tr><th>Expected date</th><th>What</th><th className="num">In</th><th className="num">Out</th><th className="num">Balance</th></tr></thead>
            <tbody>
              {d.movements.map((m: any, i: number) => (
                <tr
                  key={i}
                  className={m.source ? 'click' : undefined}
                  {...(m.source ? { tabIndex: 0, role: 'button', onClick: () => openSource(m.source.type, m.source.id), onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSource(m.source.type, m.source.id); } } } : {})}
                >
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(m.date)}</td>
                  <td>
                    {m.label}
                    {m.estimated && <span className="badge" style={{ marginLeft: 8 }}>estimated</span>}
                  </td>
                  <td className="num" style={{ color: m.in ? 'var(--green)' : undefined }}>{m.in ? <Money cents={m.in} /> : ''}</td>
                  <td className="num" style={{ color: m.out ? 'var(--red)' : undefined }}>{m.out ? <Money cents={m.out} /> : ''}</td>
                  <td className="num" style={{ color: m.balance < 0 ? 'var(--red)' : undefined, fontWeight: 600 }}><Money cents={m.balance} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="muted small" style={{ marginTop: 12 }}>
        This is an estimate. It assumes invoices and bills are settled on their due dates (overdue ones are treated as due now), and includes documents your recurring schedules will raise within the window (shown as “estimated”). It doesn’t predict brand-new sales or costs you haven’t recorded.
      </p>
    </>
  );
}
