import React, { useState } from 'react';
import { useApi, useToast, Money, Badge, Empty, Modal, Field, PickAccount, ErrorBanner } from '../components';
import { DateField } from '../components';
import { api, money, toCents, fromCents, fmtDate, todayIso } from '../api';

export default function Assets() {
  const { data, error, reload } = useApi<any[]>('assets.list');
  const { data: runs, reload: reloadRuns } = useApi<any[]>('assets.runs');
  const toast = useToast();
  const [editing, setEditing] = useState<any | null>(null);
  const [disposing, setDisposing] = useState<any | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [periodEnd, setPeriodEnd] = useState(() => {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0)).toISOString().slice(0, 10);
  });

  async function runDeprn() {
    setErr(null);
    try {
      const r = await api('assets.runDepreciation', periodEnd);
      toast(`Depreciation posted for ${r.entries.length} asset(s)`);
      reload(); reloadRuns();
    } catch (e: any) { setErr(e.message); }
  }

  return (
    <>
      <div className="page-head">
        <h1>Fixed assets</h1>
        <div className="grow" />
        <DateField style={{ width: 160 }} value={periodEnd} onChange={setPeriodEnd} label="period-end date" />
        <button className="btn" onClick={runDeprn}>Run depreciation</button>
        <button className="btn primary" onClick={() => setEditing({})}>+ New asset</button>
      </div>
      <ErrorBanner msg={error ?? err} />
      <div className="card tight">
        {data && data.length === 0 ? (
          <Empty title="No fixed assets" sub="Register equipment and run monthly depreciation against it." />
        ) : (
          <table className="tbl">
            <thead><tr><th>Asset</th><th>Type</th><th>Purchased</th><th>Method</th><th>Status</th><th className="num">Cost</th><th className="num">Accum. deprn</th><th className="num">Book value</th><th /></tr></thead>
            <tbody>
              {(data ?? []).map((a) => (
                <tr key={a.id}>
                  <td><strong>{a.name}</strong><div className="faint small">{a.asset_number}</div></td>
                  <td>{a.type_name}</td>
                  <td>{fmtDate(a.purchase_date)}</td>
                  <td className="small">{a.depreciation_method === 'STRAIGHT_LINE' ? `Straight line / ${a.effective_life}y` : a.depreciation_method.toLowerCase()}</td>
                  <td><Badge status={a.status} /></td>
                  <td className="num"><Money cents={a.purchase_price} /></td>
                  <td className="num"><Money cents={a.accumulated_depreciation} /></td>
                  <td className="num"><Money cents={a.book_value} /></td>
                  <td className="btn-row">
                    {a.status === 'DRAFT' && <button className="btn small" onClick={async () => { try { await api('assets.register', a.id); toast('Asset registered'); reload(); } catch (e: any) { setErr(e.message); } }}>Register</button>}
                    {a.status === 'REGISTERED' && <button className="btn small danger" onClick={() => setDisposing(a)}>Dispose</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card tight">
        <table className="tbl">
          <thead><tr><th>Depreciation run</th><th className="num">Assets</th><th className="num">Total posted</th></tr></thead>
          <tbody>
            {(runs ?? []).map((r) => (
              <tr key={r.id}><td>Through {fmtDate(r.period_end)}</td><td className="num">{r.entries}</td><td className="num"><Money cents={r.total} /></td></tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && <AssetEditor asset={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
      {disposing && <DisposeModal asset={disposing} onClose={() => setDisposing(null)} onDone={() => { setDisposing(null); reload(); }} />}
    </>
  );
}

function AssetEditor({ asset, onClose, onSaved }: { asset: any; onClose: () => void; onSaved: () => void }) {
  const { data: types } = useApi<any[]>('assets.listTypes');
  const toast = useToast();
  const [f, setF] = useState<any>({ depreciation_method: 'STRAIGHT_LINE', purchase_date: todayIso(), ...asset });
  const [err, setErr] = useState<string | null>(null);
  const [showType, setShowType] = useState(false);
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));

  async function save() {
    setErr(null);
    try {
      await api('assets.save', {
        ...f,
        purchase_price: f.price_txt != null ? toCents(f.price_txt) : f.purchase_price,
        residual_value: f.residual_txt != null ? toCents(f.residual_txt) : f.residual_value ?? 0,
        effective_life: f.effective_life ? Number(f.effective_life) : null,
        rate: f.rate ? Number(f.rate) : null,
      });
      toast('Asset saved');
      onSaved();
    } catch (e: any) { setErr(e.message); }
  }

  return (
    <Modal title={asset.id ? 'Edit asset' : 'New fixed asset'} onClose={onClose}>
      <ErrorBanner msg={err} />
      <div className="form-row">
        <Field label="Name"><input value={f.name ?? ''} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="Asset number"><input value={f.asset_number ?? ''} onChange={(e) => set('asset_number', e.target.value)} /></Field>
      </div>
      <div className="form-row">
        <Field label="Asset type">
          <select value={f.asset_type_id ?? ''} onChange={(e) => set('asset_type_id', Number(e.target.value))}>
            <option value="">Choose…</option>
            {(types ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
        <Field label=" ">
          <button className="btn small" onClick={() => setShowType(true)}>+ New type</button>
        </Field>
      </div>
      <div className="form-row">
        <Field label="Purchase date"><DateField value={f.purchase_date ?? ''} onChange={(v) => set('purchase_date', v)} label="purchase date" /></Field>
        <Field label="Purchase price"><input className="num" value={f.price_txt ?? fromCents(f.purchase_price ?? 0)} onChange={(e) => set('price_txt', e.target.value)} /></Field>
        <Field label="Residual value"><input className="num" value={f.residual_txt ?? fromCents(f.residual_value ?? 0)} onChange={(e) => set('residual_txt', e.target.value)} /></Field>
      </div>
      <div className="form-row">
        <Field label="Method">
          <select value={f.depreciation_method} onChange={(e) => set('depreciation_method', e.target.value)}>
            <option value="STRAIGHT_LINE">Straight line</option>
            <option value="DIMINISHING">Diminishing value</option>
            <option value="NONE">No depreciation</option>
          </select>
        </Field>
        <Field label="Effective life (years)"><input className="num" value={f.effective_life ?? ''} onChange={(e) => set('effective_life', e.target.value)} /></Field>
        <Field label="or rate %/yr"><input className="num" value={f.rate ?? ''} onChange={(e) => set('rate', e.target.value)} /></Field>
      </div>
      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save}>Save</button>
      </div>
      {showType && <AssetTypeEditor onClose={() => setShowType(false)} onSaved={() => setShowType(false)} />}
    </Modal>
  );
}

function AssetTypeEditor({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState<any>({ default_method: 'STRAIGHT_LINE' });
  const [err, setErr] = useState<string | null>(null);
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  async function save() {
    setErr(null);
    try {
      await api('assets.saveType', f);
      toast('Asset type created');
      onSaved();
    } catch (e: any) { setErr(e.message); }
  }
  return (
    <Modal title="New asset type" onClose={onClose}>
      <ErrorBanner msg={err} />
      <div className="form-row"><Field label="Name"><input value={f.name ?? ''} onChange={(e) => set('name', e.target.value)} /></Field></div>
      <div className="form-row">
        <Field label="Asset account"><PickAccount value={f.asset_account_id ?? ''} onChange={(id) => set('asset_account_id', id)} types={['ASSET']} /></Field>
        <Field label="Accumulated depreciation"><PickAccount value={f.accumulated_dep_account_id ?? ''} onChange={(id) => set('accumulated_dep_account_id', id)} types={['ASSET']} /></Field>
        <Field label="Depreciation expense"><PickAccount value={f.expense_account_id ?? ''} onChange={(id) => set('expense_account_id', id)} types={['EXPENSE']} /></Field>
      </div>
      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save}>Create</button>
      </div>
    </Modal>
  );
}

function DisposeModal({ asset, onClose, onDone }: { asset: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [date, setDate] = useState(todayIso());
  const [proceeds, setProceeds] = useState('0.00');
  const [err, setErr] = useState<string | null>(null);
  async function submit() {
    setErr(null);
    try {
      await api('assets.dispose', asset.id, { date, proceeds: toCents(proceeds) });
      toast('Asset disposed');
      onDone();
    } catch (e: any) { setErr(e.message); }
  }
  return (
    <Modal title={`Dispose ${asset.name}`} onClose={onClose}>
      <ErrorBanner msg={err} />
      <p className="muted">Book value {money(asset.book_value)}. Proceeds above book value post a gain; below, a loss.</p>
      <div className="form-row">
        <Field label="Disposal date"><DateField value={date} onChange={setDate} label="disposal date" /></Field>
        <Field label="Sale proceeds"><input className="num" value={proceeds} onChange={(e) => setProceeds(e.target.value)} /></Field>
      </div>
      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn danger" onClick={submit}>Dispose asset</button>
      </div>
    </Modal>
  );
}
