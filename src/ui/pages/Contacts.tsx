import React, { useState, useEffect } from 'react';
import { useApi, useToast, Money, Badge, Empty, Modal, Field, ErrorBanner, openSource, SearchSelect, ConfirmDanger, usePager, Pager, rowActivate } from '../components';
import { EmailField } from '../components';
import { api, fmtDate, money, saveCsv, exportPdf } from '../api';

export default function Contacts({ route }: { route?: string[] }) {
  const [filter, setFilter] = useState<'ALL' | 'CUSTOMERS' | 'SUPPLIERS' | 'ARCHIVED'>('ALL');
  const [search, setSearch] = useState('');
  const { data, error, reload } = useApi<any[]>('contacts.list', { filter, search: search || undefined });
  const pager = usePager(data, [filter, search]);
  const [editing, setEditing] = useState<any | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const [merging, setMerging] = useState(false);
  // Deep-link: /contacts/<id> (e.g. from quick search) opens that contact.
  useEffect(() => {
    const target = route && route[1] ? Number(route[1]) : null;
    if (target && !Number.isNaN(target)) setViewing(target);
  }, [route?.[1]]);
  const { data: mergeHist, reload: reloadMerges } = useApi<any[]>('contacts.mergeHistory');

  return (
    <>
      <div className="page-head">
        <h1>Contacts</h1>
        <div className="grow" />
        <button className="btn" onClick={() => setMerging(true)}>Merge duplicates</button>
        <button className="btn primary" onClick={() => setEditing({})}>+ New contact</button>
      </div>
      <ErrorBanner msg={error} />
      <div className="page-head">
        <input className="searchbox" placeholder="Search name or email…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select style={{ width: 160 }} value={filter} onChange={(e) => setFilter(e.target.value as any)}>
          <option value="ALL">All</option><option value="CUSTOMERS">Customers</option>
          <option value="SUPPLIERS">Suppliers</option><option value="ARCHIVED">Archived</option>
        </select>
      </div>
      <div className="card tight">
        {data && data.length === 0 ? (
          <Empty title="No contacts yet" sub="Add the customers and suppliers you invoice or pay." actionLabel="+ New contact" onAction={() => setEditing({})} />
        ) : (
          <table className="tbl">
            <thead><tr><th>Name</th><th>Email</th><th>Type</th><th className="num">They owe you</th><th className="num">You owe them</th></tr></thead>
            <tbody>
              {pager.slice.map((c: any) => (
                <tr key={c.id} className="click" {...rowActivate(() => setViewing(c.id))}>
                  <td><strong>{c.name}</strong></td>
                  <td className="muted">{c.email}</td>
                  <td>
                    {!!c.is_customer && <span className="badge blue">customer</span>}{' '}
                    {!!c.is_supplier && <span className="badge grey">supplier</span>}
                  </td>
                  <td className="num"><Money cents={c.owes_you} /></td>
                  <td className="num"><Money cents={c.you_owe} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data && data.length > 0 && <Pager pager={pager} noun="contacts" />}
      </div>
      {merging && (
        <MergeContactsModal
          contacts={(data ?? [])}
          onClose={() => setMerging(false)}
          onDone={() => { setMerging(false); reload(); reloadMerges(); }}
        />
      )}
      {(mergeHist ?? []).length > 0 && (
        <div className="card">
          <h2>Recent merges</h2>
          <p className="muted small">Merged a contact by mistake? Undo restores it to active with its original name and moves its transactions back.</p>
          <table className="tbl">
            <thead><tr><th>When</th><th>Merged away</th><th>Into</th><th>By</th><th /></tr></thead>
            <tbody>
              {(mergeHist ?? []).map((m: any) => (
                <tr key={m.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{m.merged_at}</td>
                  <td>{m.from_name_before}</td>
                  <td>{m.into_name}</td>
                  <td>{m.user_name ?? '—'}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn small" onClick={async () => {
                      const r = await api('contacts.unmerge', m.id);
                      if (r != null) { reload(); reloadMerges(); }
                    }}>Undo merge</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && <ContactEditor contact={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
      {viewing != null && (
        <ContactDetail id={viewing} onClose={() => setViewing(null)} onEdit={(c) => { setViewing(null); setEditing(c); }} onChanged={reload} />
      )}
    </>
  );
}

function ContactDetail({ id, onClose, onEdit, onChanged }: { id: number; onClose: () => void; onEdit: (c: any) => void; onChanged: () => void }) {
  const { data: c } = useApi<any>('contacts.get', id);
  const { data: act } = useApi<any>('contacts.activity', id, {});
  const toast = useToast();
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  if (!c) return null;

  const KIND_LABEL: Record<string, string> = {
    ACCREC: 'Invoice', ACCPAY: 'Bill', ACCRECCREDIT: 'Credit note', ACCPAYCREDIT: 'Supplier credit',
    QUOTE: 'Quote', PURCHASEORDER: 'Purchase order',
    PAYMENT_IN: 'Payment received', PAYMENT_OUT: 'Payment made',
    RECEIVE_MONEY: 'Receive money', SPEND_MONEY: 'Spend money',
  };
  const query = q.trim().toLowerCase();
  const rows = (act?.rows ?? []).filter((r: any) => {
    if (kind && r.kind !== kind) return false;
    if (query) {
      const hay = `${r.number ?? ''} ${r.reference ?? ''} ${KIND_LABEL[r.kind] ?? r.kind}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });
  const kindsPresent = [...new Set((act?.rows ?? []).map((r: any) => r.kind))] as string[];

  async function exportCsv() {
    setBusy(true);
    try {
      const r = await api('reports.exportCsv', { report: 'contact_activity', contact_id: id });
      await saveCsv(r.csv, r.filename);
    } finally { setBusy(false); }
  }
  async function exportPdfStatement() {
    setBusy(true);
    try {
      const el = document.getElementById('contact-activity');
      if (!el) return;
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>
        body{font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#1f2933;margin:40px;font-size:12.5px}
        h1{font-size:22px;margin:0 0 2px} .muted{color:#52606d} table{width:100%;border-collapse:collapse;margin-top:14px}
        th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#52606d;border-bottom:2px solid #1f2933;padding:7px 9px}
        td{padding:7px 9px;border-bottom:1px solid #e4e7eb} .num{text-align:right;white-space:nowrap}
        .badge{border:1px solid #cbd2d9;border-radius:10px;padding:1px 7px;font-size:10px}</style></head>
        <body><h1>${c.name} — activity</h1><div class="muted">All transactions on record</div>${el.innerHTML}</body></html>`;
      await exportPdf(html, `activity-${c.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.pdf`);
    } finally { setBusy(false); }
  }

  return (
    <Modal title={c.name} wide onClose={onClose}>
      <div style={{ display: 'flex', gap: 26, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div className="kv" style={{ minWidth: 250 }}>
          <span className="k">Email</span><span>{c.email ?? '—'}</span>
          <span className="k">Phone</span><span>{c.phone ?? '—'}</span>
          <span className="k">Tax number</span><span>{c.tax_number ?? '—'}</span>
          <span className="k">Status</span><span><Badge status={c.status} /></span>
        </div>
        <div className="kv" style={{ minWidth: 220 }}>
          <span className="k">They owe you</span><span><strong><Money cents={act?.outstanding_receivable ?? 0} /></strong></span>
          <span className="k">You owe them</span><span><strong><Money cents={act?.outstanding_payable ?? 0} /></strong></span>
          <span className="k">Transactions</span><span>{(act?.rows ?? []).length}</span>
        </div>
        <div className="btn-row" style={{ marginLeft: 'auto' }}>
          <button className="btn" onClick={() => onEdit(c)}>Edit</button>
          {c.status === 'ACTIVE' ? (
            <button className="btn danger" onClick={async () => { await api('contacts.archive', id); toast('Contact archived'); onChanged(); onClose(); }}>Archive</button>
          ) : (
            <button className="btn" onClick={async () => { await api('contacts.restore', id); toast('Contact restored'); onChanged(); onClose(); }}>Restore</button>
          )}
        </div>
      </div>

      <div className="report-toolbar" style={{ marginTop: 18 }}>
        <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: 190 }}>
          <option value="">All transaction types</option>
          {kindsPresent.map((k) => <option key={k} value={k}>{KIND_LABEL[k] ?? k}</option>)}
        </select>
        <input placeholder="Search number or reference…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} />
        <div className="grow" />
        <button className="btn" disabled={busy} onClick={exportCsv}>Export CSV</button>
        <button className="btn" disabled={busy} onClick={exportPdfStatement}>Export PDF</button>
      </div>

      <div id="contact-activity">
        {rows.length === 0 ? (
          <Empty title="No transactions match" sub={act?.rows?.length ? 'Try clearing the filters.' : 'Nothing recorded with this contact yet.'} />
        ) : (
          <table className="tbl">
            <thead><tr><th>Date</th><th>Type</th><th>Number</th><th>Reference</th><th>Status</th><th className="num">Total</th><th className="num">Outstanding</th></tr></thead>
            <tbody>
              {rows.map((r: any) => (
                <tr key={`${r.source_type}-${r.source_id}`} className="click" title="Open transaction" onClick={() => openSource(r.source_type, r.source_id)}>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.date)}</td>
                  <td><Badge status={r.kind} label={KIND_LABEL[r.kind]} /></td>
                  <td className="mono small">{r.number ?? ''}</td>
                  <td className="small">{r.reference ?? ''}</td>
                  <td><Badge status={r.status} /></td>
                  <td className="num">{money(r.total)}</td>
                  <td className="num">{r.amount_due != null && r.amount_due !== 0 ? money(r.amount_due) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Modal>
  );
}

function ContactEditor({ contact, onClose, onSaved }: { contact: any; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState<any>({
    is_customer: true,
    ...contact,
  });
  const [err, setErr] = useState<string | null>(null);
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));

  async function save() {
    setErr(null);
    try {
      await api('contacts.save', f);
      toast('Contact saved');
      onSaved();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  return (
    <Modal title={contact.id ? 'Edit contact' : 'New contact'} onClose={onClose}>
      <ErrorBanner msg={err} />
      <div className="form-row">
        <Field label="Name"><input value={f.name ?? ''} onChange={(e) => set('name', e.target.value)} autoFocus /></Field>
      </div>
      <div className="form-row">
        <Field label="Email"><EmailField value={f.email ?? ''} onChange={(v) => set('email', v)} /></Field>
        <Field label="Phone"><input value={f.phone ?? ''} onChange={(e) => set('phone', e.target.value)} /></Field>
      </div>
      <div className="form-row">
        <Field label="Tax number"><input value={f.tax_number ?? ''} onChange={(e) => set('tax_number', e.target.value)} /></Field>
        <Field label="Default currency"><input value={f.currency_code_default ?? ''} onChange={(e) => set('currency_code_default', e.target.value.toUpperCase())} placeholder="USD" /></Field>
      </div>
      <div className="form-row">
        <div style={{ display: 'flex', gap: 22, alignItems: 'center' }}>
          <label style={{ display: 'flex', gap: 7, alignItems: 'center', fontSize: 13.5 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={!!f.is_customer} onChange={(e) => set('is_customer', e.target.checked)} /> Customer
          </label>
          <label style={{ display: 'flex', gap: 7, alignItems: 'center', fontSize: 13.5 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={!!f.is_supplier} onChange={(e) => set('is_supplier', e.target.checked)} /> Supplier
          </label>
        </div>
      </div>
      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save}>Save</button>
      </div>
    </Modal>
  );
}


function MergeContactsModal({ contacts, onClose, onDone }: { contacts: any[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [fromId, setFromId] = useState<number | ''>('');
  const [intoId, setIntoId] = useState<number | ''>('');
  const [keepName, setKeepName] = useState<'into' | 'from'>('into');
  const [preview, setPreview] = useState<any | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Only active contacts can be merged.
  const opts = contacts.filter((c) => c.status !== 'ARCHIVED').map((c) => ({ id: c.id, label: c.name }));
  const fromC = contacts.find((c) => c.id === fromId);
  const intoC = contacts.find((c) => c.id === intoId);
  const ready = fromId !== '' && intoId !== '' && fromId !== intoId;

  async function loadPreview() {
    setErr(null);
    if (!ready) { setErr('Choose two different contacts'); return; }
    try {
      const p = await api('contacts.mergePreview', fromId, intoId);
      setPreview(p);
      setConfirming(true);
    } catch (e: any) { setErr(e.message); }
  }

  async function doMerge() {
    setBusy(true);
    setErr(null);
    try {
      // Survivor is intoId; pass the chosen name so the service handles it atomically.
      const chosenName = keepName === 'from' && fromC ? fromC.name : undefined;
      await api('contacts.merge', fromId, intoId, chosenName);
      toast('Contacts merged');
      onDone();
    } catch (e: any) { setErr(e.message); setBusy(false); }
  }

  return (
    <Modal title="Merge duplicate contacts" onClose={onClose}>
      <ErrorBanner msg={err} />
      <p className="muted small">
        Move every transaction from one contact onto another, then archive the duplicate. Nothing is deleted, and the whole thing can be undone afterwards from the Recent merges list.
      </p>
      <Field label="Contact to keep">
        <SearchSelect value={intoId} onChange={(v) => { setIntoId(v); setConfirming(false); }} options={opts} placeholder="Choose the survivor…" />
      </Field>
      <Field label="Duplicate to merge in and archive">
        <SearchSelect value={fromId} onChange={(v) => { setFromId(v); setConfirming(false); }} options={opts.filter((o) => o.id !== intoId)} placeholder="Choose the duplicate…" />
      </Field>
      {fromC && intoC && fromC.name !== intoC.name && (
        <Field label="Keep which name?">
          <select value={keepName} onChange={(e) => setKeepName(e.target.value as any)}>
            <option value="into">{intoC.name}</option>
            <option value="from">{fromC.name}</option>
          </select>
        </Field>
      )}

      {!confirming ? (
        <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!ready} onClick={loadPreview}>Preview merge</button>
        </div>
      ) : (
        <ConfirmDanger
          title={`Merge "${fromC?.name}" into "${intoC?.name}"?`}
          lines={[
            `${preview?.total ?? 0} transaction reference${(preview?.total ?? 0) === 1 ? '' : 's'} will move onto "${keepName === 'from' ? fromC?.name : intoC?.name}".`,
            `"${fromC?.name}" will be archived (renamed with "(merged)").`,
            'You can undo this from Recent merges if it was a mistake.',
          ]}
          confirmLabel={busy ? 'Merging…' : 'Merge contacts'}
          onClose={() => setConfirming(false)}
          onConfirm={doMerge}
        />
      )}
    </Modal>
  );
}
