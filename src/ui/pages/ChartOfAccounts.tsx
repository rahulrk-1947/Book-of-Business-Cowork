import React, { useState } from 'react';
import { useApi, useToast, Money, Badge, Modal, Field, PickTaxRate, ErrorBanner } from '../components';
import { api, saveCsv } from '../api';

const TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'];

export default function ChartOfAccounts() {
  const [includeArchived, setIncludeArchived] = useState(false);
  const { data, error, reload } = useApi<any[]>('accounts.list', { includeArchived });
  const toast = useToast();
  const [editing, setEditing] = useState<any | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function csv() {
    const r = await api('accounts.exportCsv');
    await saveCsv(r.csv ?? r, r.filename ?? 'chart-of-accounts.csv');
  }

  const list = data ?? [];

  return (
    <>
      <div className="page-head">
        <h1>Chart of accounts</h1>
        <div className="grow" />
        <label style={{ display: 'flex', gap: 7, alignItems: 'center', fontSize: 13 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} /> Show archived
        </label>
        <button className="btn" onClick={csv}>Export CSV</button>
        <button className="btn primary" onClick={() => setEditing({})}>+ Add account</button>
      </div>
      <ErrorBanner msg={error ?? err} />
      {TYPES.map((type) => {
        const group = list.filter((a) => a.type === type);
        if (!group.length) return null;
        return (
          <div className="card tight" key={type} style={{ marginBottom: 18 }}>
            <table className="tbl">
              <thead><tr><th style={{ width: 90 }}>{type}</th><th>Name</th><th>Tax</th><th>Status</th><th className="num">Balance</th><th /></tr></thead>
              <tbody>
                {group.map((a) => (
                  <tr key={a.id} className="click" onClick={() => setEditing(a)}>
                    <td className="mono">{a.code}</td>
                    <td>
                      <strong>{a.name}</strong>
                      {['AR','AP','GST','RETAINED_EARNINGS','ROUNDING','UNREALISED_FX','REALISED_FX'].includes(a.system_account)
                        ? <span className="badge amber" style={{ marginLeft: 8 }} title="Posted automatically by the system when you record sales, bills, payments or revaluations — not selectable on document lines.">control · auto-posted</span>
                        : a.system_account && <span className="badge grey" style={{ marginLeft: 8 }}>system</span>}
                      {!!a.is_bank_account && <span className="badge blue" style={{ marginLeft: 6 }}>bank</span>}
                    </td>
                    <td className="small muted">{a.tax_rate_name ?? ''}</td>
                    <td><Badge status={a.status} /></td>
                    <td className="num"><Money cents={a.balance} /></td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {a.status === 'ACTIVE' && !a.system_account && (
                        <a onClick={async () => { try { await api('accounts.archive', a.id); toast('Account archived'); reload(); } catch (er: any) { setErr(er.message); } }}>archive</a>
                      )}
                      {a.status === 'ARCHIVED' && (
                        <a onClick={async () => { await api('accounts.restore', a.id); toast('Account restored'); reload(); }}>restore</a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
      {editing && <AccountEditor account={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </>
  );
}

function AccountEditor({ account, onClose, onSaved }: { account: any; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState<any>({ type: 'EXPENSE', ...account });
  const [err, setErr] = useState<string | null>(null);
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));

  async function save() {
    setErr(null);
    try {
      if (account.id) await api('accounts.update', account.id, f);
      else await api('accounts.create', f);
      toast('Account saved');
      onSaved();
    } catch (e: any) { setErr(e.message); }
  }

  return (
    <Modal title={account.id ? `Edit ${account.code}` : 'Add account'} onClose={onClose}>
      <ErrorBanner msg={err} />
      <div className="form-row">
        <Field label="Code"><input value={f.code ?? ''} onChange={(e) => set('code', e.target.value)} /></Field>
        <Field label="Name"><input value={f.name ?? ''} onChange={(e) => set('name', e.target.value)} /></Field>
      </div>
      <div className="form-row">
        <Field label="Type">
          <select value={f.type} onChange={(e) => set('type', e.target.value)} disabled={!!account.system_account}>
            {TYPES.map((t) => <option key={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Default tax rate"><PickTaxRate value={f.tax_rate_id_default ?? null} onChange={(id) => set('tax_rate_id_default', id)} /></Field>
      </div>
      <div className="form-row">
        <Field label="Description"><input value={f.description ?? ''} onChange={(e) => set('description', e.target.value)} /></Field>
      </div>
      {!account.system_account && (
        <div className="form-row">
          <label style={{ display: 'flex', gap: 7, alignItems: 'center', fontSize: 13.5 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={!!f.is_bank_account} onChange={(e) => set('is_bank_account', e.target.checked)} /> This is a bank account
          </label>
        </div>
      )}
      {account.system_account && <p className="small muted">System accounts keep the engine consistent — the type can't change and they can't be archived.</p>}
      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save}>Save</button>
      </div>
    </Modal>
  );
}
