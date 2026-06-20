import React, { useState, useEffect, useMemo } from 'react';
import { useApi, useToast, Money, Empty, ErrorBanner, Spinner, Modal, Field, ConfirmDanger } from '../components';
import { api, money, toCents, fromCents, fmtDate, todayIso } from '../api';

const MONTH_LABEL = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', year: '2-digit' });

export default function Budgets() {
  const { data: list, error, reload } = useApi<any[]>('budgets.list');
  const [openId, setOpenId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDel, setConfirmDel] = useState<any | null>(null);
  const toast = useToast();

  if (openId) return <BudgetEditor id={openId} onBack={() => { setOpenId(null); reload(); }} />;

  return (
    <>
      <div className="page-head">
        <h1>Budgets</h1>
        <div className="grow" />
        <button className="btn primary" onClick={() => setCreating(true)}>+ New budget</button>
      </div>
      <ErrorBanner msg={error} />

      <div className="card tight">
        {list && list.length === 0 ? (
          <Empty title="No budgets yet" sub="Create a budget to set monthly targets for your income and expenses, then track how you're doing against them." actionLabel="+ New budget" onAction={() => setCreating(true)} />
        ) : (
          <table className="tbl">
            <thead><tr><th>Name</th><th>Period</th><th className="num">Filled cells</th><th /></tr></thead>
            <tbody>
              {(list ?? []).map((b: any) => (
                <tr key={b.id} className="click" tabIndex={0} role="button" onClick={() => setOpenId(b.id)} onKeyDown={(e) => { if (e.key === 'Enter') setOpenId(b.id); }}>
                  <td><strong>{b.name}</strong></td>
                  <td>{fmtDate(b.period_start)} → {fmtDate(b.period_end)}</td>
                  <td className="num">{b.filled_cells}</td>
                  <td onClick={(e) => e.stopPropagation()} style={{ textAlign: 'right' }}>
                    <button className="btn small" onClick={() => setOpenId(b.id)}>Open</button>
                    <button className="btn small danger" onClick={() => setConfirmDel(b)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {creating && <NewBudget onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); reload(); setOpenId(id); }} />}
      {confirmDel && (
        <ConfirmDanger
          title={`Delete the budget “${confirmDel.name}”?`}
          lines={['This removes the budget and all its target amounts.', 'Your actual transactions are not affected.']}
          confirmLabel="Delete budget"
          onClose={() => setConfirmDel(null)}
          onConfirm={async () => { try { await api('budgets.remove', confirmDel.id); toast('Budget deleted'); reload(); } catch (e: any) { toast(e.message); } setConfirmDel(null); }}
        />
      )}
    </>
  );
}

function NewBudget({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [startMonth, setStartMonth] = useState(todayIso().slice(0, 7));
  const [err, setErr] = useState<string | null>(null);
  async function create() {
    setErr(null);
    if (!name.trim()) return setErr('Give the budget a name');
    try { const id = await api('budgets.create', { name, start_month: startMonth + '-01' }); onCreated(id as number); toast('Budget created'); }
    catch (e: any) { setErr(e.message); }
  }
  return (
    <Modal title="New budget" onClose={onClose}>
      <ErrorBanner msg={err} />
      <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. FY2026 operating budget" /></Field>
      <Field label="Start month"><input type="month" value={startMonth} onChange={(e) => setStartMonth(e.target.value)} /></Field>
      <p className="muted small">Budgets run for 12 months from the start month.</p>
      <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={create}>Create budget</button>
      </div>
    </Modal>
  );
}

type Cell = Record<string, string>; // key `${accountId}:${period}` -> amount string

function BudgetEditor({ id, onBack }: { id: number; onBack: () => void }) {
  const toast = useToast();
  const { data: budget, loading } = useApi<any>('budgets.get', id);
  const { data: accounts } = useApi<any[]>('accounts.list', {});
  const [tab, setTab] = useState<'edit' | 'actual'>('edit');
  const [cells, setCells] = useState<Cell>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!budget) return;
    const c: Cell = {};
    for (const l of budget.lines) c[`${l.account_id}:${l.period}`] = fromCents(l.amount);
    setCells(c);
    setDirty(false);
  }, [budget]);

  const plAccounts = useMemo(
    () => (accounts ?? []).filter((a: any) => (a.type === 'REVENUE' || a.type === 'EXPENSE') && a.status === 'ACTIVE'),
    [accounts]
  );
  const income = plAccounts.filter((a: any) => a.type === 'REVENUE');
  const expense = plAccounts.filter((a: any) => a.type === 'EXPENSE');

  if (loading || !budget) return <Spinner />;
  const monthsArr: string[] = budget.months;

  const setCell = (acctId: number, period: string, val: string) => {
    setCells((c) => ({ ...c, [`${acctId}:${period}`]: val }));
    setDirty(true);
  };
  const fillAcross = (acctId: number) => {
    const first = cells[`${acctId}:${monthsArr[0]}`] || '';
    setCells((c) => { const n = { ...c }; for (const m of monthsArr) n[`${acctId}:${m}`] = first; return n; });
    setDirty(true);
  };
  const rowTotal = (acctId: number) => monthsArr.reduce((s, m) => s + (parseFloat(cells[`${acctId}:${m}`] || '0') || 0), 0);

  async function save() {
    setSaving(true);
    const lines: any[] = [];
    for (const a of plAccounts) for (const m of monthsArr) {
      const v = cells[`${a.id}:${m}`];
      lines.push({ account_id: a.id, period: m, amount: toCents(v || '0') });
    }
    try { await api('budgets.setLines', id, lines); toast('Budget saved'); setDirty(false); }
    catch (e: any) { toast(e.message); }
    finally { setSaving(false); }
  }

  const section = (title: string, accts: any[]) => (
    <>
      <tr className="budget-section"><td colSpan={monthsArr.length + 2}>{title}</td></tr>
      {accts.map((a: any) => (
        <tr key={a.id}>
          <td className="budget-acct" title={`${a.code} ${a.name}`}>
            {a.code} {a.name}
            <button className="icon-btn" title="Copy the first month across all months" onClick={() => fillAcross(a.id)} style={{ marginLeft: 6 }}>→</button>
          </td>
          {monthsArr.map((m) => (
            <td key={m}><input className="num budget-cell" value={cells[`${a.id}:${m}`] ?? ''} placeholder="0" onChange={(e) => setCell(a.id, m, e.target.value)} /></td>
          ))}
          <td className="num budget-total"><Money cents={toCents(String(rowTotal(a.id)))} /></td>
        </tr>
      ))}
    </>
  );

  return (
    <>
      <div className="page-head">
        <button className="btn small" onClick={onBack}>← Budgets</button>
        <h1 style={{ marginLeft: 8 }}>{budget.name}</h1>
        <span className="muted" style={{ marginLeft: 8 }}>{fmtDate(budget.period_start)} → {fmtDate(budget.months[11])}</span>
        <div className="grow" />
        <div className="seg">
          <button className={`seg-btn${tab === 'edit' ? ' active' : ''}`} onClick={() => setTab('edit')}>Edit budget</button>
          <button className={`seg-btn${tab === 'actual' ? ' active' : ''}`} onClick={() => setTab('actual')}>Budget vs actual</button>
        </div>
      </div>

      {tab === 'edit' ? (
        <>
          <div className="card tight">
            <table className="tbl budget-grid">
              <thead><tr><th style={{ minWidth: 200 }}>Account</th>{monthsArr.map((m) => <th key={m} className="num">{MONTH_LABEL(m)}</th>)}<th className="num">Total</th></tr></thead>
              <tbody>
                {income.length > 0 && section('Income', income)}
                {expense.length > 0 && section('Expenses', expense)}
              </tbody>
            </table>
          </div>
          <div className="btn-row" style={{ marginTop: 12 }}>
            <button className="btn primary" disabled={!dirty || saving} onClick={save}>{saving ? 'Saving…' : dirty ? 'Save budget' : 'Saved'}</button>
            <span className="muted small">Enter monthly amounts. Use → on a row to copy the first month across the year.</span>
          </div>
        </>
      ) : (
        <BudgetVsActual budget={budget} />
      )}
    </>
  );
}

function BudgetVsActual({ budget }: { budget: any }) {
  const [from, setFrom] = useState(budget.period_start);
  const [to, setTo] = useState(budget.months[11].slice(0, 8) + '28');
  const { data, loading, error } = useApi<any>('budgets.vsActual', { budget_id: budget.id, from, to });

  const VarCell = ({ r }: { r: any }) => (
    <td className="num" style={{ color: r.variance === 0 ? undefined : (r.favourable ? 'var(--green)' : 'var(--red)'), fontWeight: 600 }}>
      <Money cents={r.variance} />
    </td>
  );
  const rows = (arr: any[]) => arr.map((r: any) => (
    <tr key={r.account_id}>
      <td>{r.code} {r.name}</td>
      <td className="num"><Money cents={r.actual} /></td>
      <td className="num"><Money cents={r.budget} /></td>
      <VarCell r={r} />
    </tr>
  ));

  return (
    <>
      <div className="report-toolbar" style={{ alignItems: 'flex-end' }}>
        <label className="filter-field"><span className="filter-label">From</span><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="filter-field"><span className="filter-label">To</span><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <ErrorBanner msg={error} />
      {loading || !data ? <Spinner /> : (
        <div className="card tight">
          <table className="tbl">
            <thead><tr><th>Account</th><th className="num">Actual</th><th className="num">Budget</th><th className="num">Variance</th></tr></thead>
            <tbody>
              <tr className="budget-section"><td colSpan={4}>Income</td></tr>
              {rows(data.income)}
              <tr className="budget-subtotal"><td>Total income</td><td className="num"><Money cents={data.totals.income.actual} /></td><td className="num"><Money cents={data.totals.income.budget} /></td><td className="num"><Money cents={data.totals.income.actual - data.totals.income.budget} /></td></tr>
              <tr className="budget-section"><td colSpan={4}>Expenses</td></tr>
              {rows(data.expense)}
              <tr className="budget-subtotal"><td>Total expenses</td><td className="num"><Money cents={data.totals.expense.actual} /></td><td className="num"><Money cents={data.totals.expense.budget} /></td><td className="num"><Money cents={data.totals.expense.actual - data.totals.expense.budget} /></td></tr>
              <tr className="budget-net"><td>Net profit</td><td className="num"><Money cents={data.net.actual} /></td><td className="num"><Money cents={data.net.budget} /></td><td className="num" style={{ color: (data.net.actual - data.net.budget) >= 0 ? 'var(--green)' : 'var(--red)' }}><Money cents={data.net.actual - data.net.budget} /></td></tr>
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small" style={{ marginTop: 10 }}>Actuals come from your posted transactions. Variance is actual minus budget — shown green when it’s in your favour (more income, or less spend than planned).</p>
    </>
  );
}
