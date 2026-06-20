import React, { useState } from 'react';
import { useApi, useToast, Money, Badge, Empty, Modal, Field, PickAccount, PickTaxRate, DateField, ErrorBanner } from '../components';
import { api, money, toCents, fromCents, todayIso } from '../api';

export default function Items() {
  const [search, setSearch] = useState('');
  const { data, error, reload } = useApi<any[]>('items.list', { search: search || undefined });
  const [editing, setEditing] = useState<any | null>(null);
  const [adjusting, setAdjusting] = useState<any | null>(null);

  return (
    <>
      <div className="page-head">
        <h1>Products &amp; services</h1>
        <div className="grow" />
        <button className="btn primary" onClick={() => setEditing({})}>+ New item</button>
      </div>
      <ErrorBanner msg={error} />
      <div className="page-head">
        <input className="searchbox" placeholder="Search code or name…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div className="card tight">
        {data && data.length === 0 ? (
          <Empty title="No items yet" sub="Items pre-fill invoice and bill lines; tracked items also maintain stock at average cost." />
        ) : (
          <table className="tbl">
            <thead><tr><th>Code</th><th>Name</th><th>Type</th><th className="num">Sell at</th><th className="num">Buy at</th><th className="num">On hand</th><th className="num">Stock value</th><th /></tr></thead>
            <tbody>
              {(data ?? []).map((it) => (
                <tr key={it.id} className="click" onClick={() => setEditing(it)}>
                  <td className="mono">{it.code}</td>
                  <td><strong>{it.name}</strong></td>
                  <td>{it.is_tracked ? <span className="badge blue">tracked</span> : <span className="badge grey">untracked</span>}</td>
                  <td className="num">{it.i_sell ? money(it.sales_unit_price) : '—'}</td>
                  <td className="num">{it.i_purchase ? money(it.purchase_unit_price) : '—'}</td>
                  <td className="num">{it.is_tracked ? <>{it.quantity_on_hand}{it.reorder_point != null && it.quantity_on_hand < it.reorder_point && <span className="badge" style={{ marginLeft: 6, background: 'var(--danger, #c0392b)', color: '#fff' }}>low</span>}</> : '—'}</td>
                  <td className="num">{it.is_tracked ? money(it.total_value) : '—'}</td>
                  <td className="num">{it.is_tracked && <button className="btn small" onClick={(e) => { e.stopPropagation(); setAdjusting(it); }}>Adjust</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editing && <ItemEditor item={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
      {adjusting && <AdjustStockModal item={adjusting} onClose={() => setAdjusting(null)} onSaved={() => { setAdjusting(null); reload(); }} />}
    </>
  );
}

function ItemEditor({ item, onClose, onSaved }: { item: any; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState<any>({ i_sell: true, ...item });
  const [err, setErr] = useState<string | null>(null);
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));

  async function save() {
    setErr(null);
    try {
      await api('items.save', {
        ...f,
        sales_unit_price: f.sales_unit_price_txt != null ? toCents(f.sales_unit_price_txt) : f.sales_unit_price,
        purchase_unit_price: f.purchase_unit_price_txt != null ? toCents(f.purchase_unit_price_txt) : f.purchase_unit_price,
      });
      toast('Item saved');
      onSaved();
    } catch (e: any) { setErr(e.message); }
  }

  return (
    <Modal title={item.id ? `Edit ${item.code}` : 'New item'} onClose={onClose}>
      <ErrorBanner msg={err} />
      <div className="form-row">
        <Field label="Code"><input value={f.code ?? ''} onChange={(e) => set('code', e.target.value)} /></Field>
        <Field label="Name"><input value={f.name ?? ''} onChange={(e) => set('name', e.target.value)} /></Field>
      </div>
      <div className="form-row">
        <div style={{ display: 'flex', gap: 22, alignItems: 'center' }}>
          <label style={{ display: 'flex', gap: 7, alignItems: 'center', fontSize: 13.5 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={!!f.i_sell} onChange={(e) => set('i_sell', e.target.checked)} /> I sell this
          </label>
          <label style={{ display: 'flex', gap: 7, alignItems: 'center', fontSize: 13.5 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={!!f.i_purchase} onChange={(e) => set('i_purchase', e.target.checked)} /> I purchase this
          </label>
          <label style={{ display: 'flex', gap: 7, alignItems: 'center', fontSize: 13.5 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={!!f.is_tracked} onChange={(e) => set('is_tracked', e.target.checked)} /> Track stock
          </label>
        </div>
      </div>
      {!!f.i_sell && (
        <div className="form-row">
          <Field label="Sale price"><input className="num" value={f.sales_unit_price_txt ?? fromCents(f.sales_unit_price ?? 0)} onChange={(e) => set('sales_unit_price_txt', e.target.value)} /></Field>
          <Field label="Sales account"><PickAccount value={f.sales_account_id ?? ''} onChange={(id) => set('sales_account_id', id)} types={['REVENUE']} /></Field>
          <Field label="Sales tax"><PickTaxRate value={f.sales_tax_rate_id ?? null} onChange={(id) => set('sales_tax_rate_id', id)} side="sales" /></Field>
        </div>
      )}
      {!!f.i_purchase && (
        <div className="form-row">
          <Field label="Purchase price"><input className="num" value={f.purchase_unit_price_txt ?? fromCents(f.purchase_unit_price ?? 0)} onChange={(e) => set('purchase_unit_price_txt', e.target.value)} /></Field>
          <Field label="Purchase account"><PickAccount value={f.purchase_account_id ?? ''} onChange={(id) => set('purchase_account_id', id)} types={['EXPENSE', 'ASSET']} /></Field>
          <Field label="Purchase tax"><PickTaxRate value={f.purchase_tax_rate_id ?? null} onChange={(id) => set('purchase_tax_rate_id', id)} side="purchases" /></Field>
        </div>
      )}
      {!!f.is_tracked && (
        <div className="form-row">
          <Field label="Inventory asset account"><PickAccount value={f.inventory_asset_account_id ?? ''} onChange={(id) => set('inventory_asset_account_id', id)} types={['ASSET']} /></Field>
          <Field label="Cost of goods sold account"><PickAccount value={f.cogs_account_id ?? ''} onChange={(id) => set('cogs_account_id', id)} types={['EXPENSE']} /></Field>
          <Field label="Reorder point"><input type="number" min={0} step="any" inputMode="decimal" value={f.reorder_point ?? ''} placeholder="optional" onChange={(e) => set('reorder_point', e.target.value === '' ? null : Number(e.target.value))} /></Field>
        </div>
      )}
      {item.id && !!item.is_tracked && (
        <p className="small muted">On hand: {item.quantity_on_hand} · value {money(item.total_value)} · average cost {money(item.average_cost)}</p>
      )}
      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save}>Save</button>
      </div>
    </Modal>
  );
}

function AdjustStockModal({ item, onClose, onSaved }: { item: any; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [mode, setMode] = useState<'set' | 'by'>('set');
  const [date, setDate] = useState(todayIso());
  const [target, setTarget] = useState('');
  const [unitCost, setUnitCost] = useState(item.average_cost ? String(fromCents(item.average_cost)) : '');
  const [account, setAccount] = useState<number | ''>(item.cogs_account_id ?? '');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const current = item.quantity_on_hand;
  const raw = target === '' ? null : Number(target);
  const delta = raw == null || !Number.isFinite(raw) ? 0 : mode === 'set' ? raw - current : raw;

  async function save() {
    if (!Number.isFinite(delta) || delta === 0) { setErr('Enter a quantity that changes the stock on hand.'); return; }
    if (!account) { setErr('Choose an account to post the adjustment against.'); return; }
    if (delta > 0 && !unitCost && !item.average_cost) { setErr('Enter a unit cost for the added stock.'); return; }
    setBusy(true); setErr(null);
    try {
      await api('items.adjustStock', {
        item_id: item.id, date, quantity_delta: delta,
        unit_cost: delta > 0 && unitCost ? toCents(unitCost) : undefined,
        account_id: account, reason: reason || undefined,
      });
      toast('Stock adjusted');
      onSaved();
    } catch (e: any) { setErr(e.message); setBusy(false); }
  }

  return (
    <Modal title={`Adjust stock — ${item.code}`} onClose={onClose}>
      {err && <ErrorBanner msg={err} />}
      <p className="small muted">On hand now: <strong>{current}</strong> · average cost {money(item.average_cost)}</p>
      <div className="form-row">
        <Field label="Date"><DateField value={date} onChange={setDate} /></Field>
        <Field label="Method">
          <select value={mode} onChange={(e) => setMode(e.target.value as any)}>
            <option value="set">Set counted quantity</option>
            <option value="by">Adjust by (+/−)</option>
          </select>
        </Field>
        <Field label={mode === 'set' ? 'Counted quantity' : 'Change (+/−)'}>
          <input type="number" step="any" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} autoFocus />
        </Field>
      </div>
      <p className="small muted">This will change stock by <strong>{delta > 0 ? '+' : ''}{Number.isFinite(delta) ? delta : 0}</strong>{delta !== 0 ? ` → ${current + delta} on hand` : ''}.</p>
      {delta > 0 && (
        <Field label="Unit cost of added stock"><input type="number" step="any" inputMode="decimal" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} placeholder="0.00" /></Field>
      )}
      <div className="form-row">
        <Field label="Post adjustment to"><PickAccount value={account} onChange={setAccount} types={['EXPENSE', 'REVENUE']} /></Field>
        <Field label="Reason"><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. stocktake, breakage" /></Field>
      </div>
      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={save}>Post adjustment</button>
      </div>
    </Modal>
  );
}
