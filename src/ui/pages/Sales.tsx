import React, { useState, useEffect } from 'react';
import { ImportModal } from '../ImportModal';
import { useApi, useToast, Money, Badge, Empty, Tabs, ErrorBanner, ConfirmDanger, usePager, Pager, useColumns, ColumnChooser, rowActivate } from '../components';
import { api, fmtDate, saveCsv } from '../api';
import { DocumentEditor, DocumentViewer, DocKind } from './DocumentEditor';

export default function Sales() {
  const [tab, setTab] = useState('invoices');
  return (
    <>
      <div className="page-head"><h1>Sales</h1></div>
      <Tabs
        tabs={[
          { id: 'invoices', label: 'Invoices' },
          { id: 'quotes', label: 'Quotes' },
          { id: 'credits', label: 'Credit notes' },
          { id: 'repeating', label: 'Repeating' },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'invoices' && <DocList kind="ACCREC" newLabel="New invoice" />}
      {tab === 'quotes' && <QuoteList />}
      {tab === 'credits' && <DocList kind="ACCRECCREDIT" newLabel="New credit note" />}
      {tab === 'repeating' && <RepeatingList />}
    </>
  );
}

export function DocList({ kind, newLabel }: { kind: DocKind; newLabel: string }) {
  const [importing, setImporting] = useState(false);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const { data, error, reload } = useApi<any[]>('invoices.list', { type: kind, status: status || undefined, search: search || undefined });
  const pager = usePager(data, [kind, status, search]);
  const [editing, setEditing] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  const [cols, setCols] = useColumns<Record<string, boolean>>(`doclist-${kind}`, { contact: true, date: true, due: true, status: true, total: true, amount_due: true });
  const toast = useToast();
  // ── Selection for bulk actions ──
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [confirmVoid, setConfirmVoid] = useState(false);
  // Drop selections that are no longer in view (filters changed, data reloaded).
  useEffect(() => {
    const ids = new Set((data ?? []).map((d: any) => d.id));
    setSelected((prev) => { const next = new Set([...prev].filter((id) => ids.has(id))); return next.size === prev.size ? prev : next; });
  }, [data]);
  const pageIds = pager.slice.map((d: any) => d.id);
  const allOnPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const toggle = (id: number) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleAll = () => setSelected((prev) => {
    const n = new Set(prev);
    if (allOnPageSelected) pageIds.forEach((id) => n.delete(id));
    else pageIds.forEach((id) => n.add(id));
    return n;
  });
  const selById = (id: number) => (data ?? []).find((d: any) => d.id === id);
  const selArr = [...selected];
  // Which actions make sense for the current selection.
  const canApprove = selArr.some((id) => { const d = selById(id); return d && ['DRAFT', 'SUBMITTED'].includes(d.status); });
  const canVoid = selArr.some((id) => { const d = selById(id); return d && d.status !== 'VOIDED' && d.status !== 'DELETED' && !(d.amount_paid > 0); });

  function summarise(r: any, verb: string) {
    if (r.fail_count === 0) toast(`${verb} ${r.ok_count} document${r.ok_count === 1 ? '' : 's'}`);
    else {
      const eg = r.failed[0];
      toast(`${verb} ${r.ok_count}, skipped ${r.fail_count}${eg ? ` (e.g. ${eg.number ?? eg.id}: ${eg.error})` : ''}`);
    }
  }
  async function doApprove() {
    setBusy(true);
    try { const r = await api('invoices.bulkApprove', selArr); summarise(r, 'Approved'); setSelected(new Set()); reload(); }
    catch (e: any) { toast(e.message); } finally { setBusy(false); }
  }
  async function doVoid() {
    setBusy(true);
    try { const r = await api('invoices.bulkVoid', selArr); summarise(r, 'Voided'); setSelected(new Set()); setConfirmVoid(false); reload(); }
    catch (e: any) { toast(e.message); } finally { setBusy(false); }
  }
  async function doExport() {
    try { const r = await api('invoices.exportSelectionCsv', selArr); await saveCsv(r.csv, r.filename); }
    catch (e: any) { toast(e.message); }
  }

  return (
    <>
      <ErrorBanner msg={error} />
      <div className="page-head">
        <input className="searchbox" placeholder="Search number, contact, reference…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select style={{ width: 180 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option>DRAFT</option><option>SUBMITTED</option><option>AUTHORISED</option><option>PAID</option><option>VOIDED</option>
        </select>
        <div className="grow" />
        <ColumnChooser
          options={[['contact', 'To / from'], ['date', 'Date'], ['due', 'Due date'], ['status', 'Status'], ['total', 'Total'], ['amount_due', 'Amount due']]}
          value={cols} onChange={setCols}
        />
        <button className="btn" onClick={() => setImporting(true)}>Import CSV</button>
        <button className="btn primary" onClick={() => setEditing(true)}>+ {newLabel}</button>
      </div>
      {importing && <ImportModal kinds={[kind]} onClose={() => setImporting(false)} onDone={reload} />}
      {selected.size > 0 && (
        <div className="bulk-bar">
          <span><strong>{selected.size}</strong> selected</span>
          <span className="grow" />
          {canApprove && <button className="btn small" disabled={busy} onClick={doApprove}>Approve</button>}
          <button className="btn small" disabled={busy} onClick={doExport}>Export CSV</button>
          {canVoid && <button className="btn small danger" disabled={busy} onClick={() => setConfirmVoid(true)}>Void</button>}
          <button className="btn small ghost" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}
      <div className="card tight">
        {data && data.length === 0 ? (
          <Empty title={`No ${newLabel.replace(/^New /i, "").toLowerCase()}s yet`} sub="They'll appear here once you create one. You can also import them from a CSV." actionLabel={`+ ${newLabel}`} onAction={() => setEditing(true)} />
        ) : (
          <table className="tbl">
            <thead><tr>
              <th style={{ width: 32 }}><input type="checkbox" aria-label="Select all on this page" checked={allOnPageSelected} onChange={toggleAll} /></th>
              <th>Number</th>
              {cols.contact && <th>To / from</th>}
              {cols.date && <th>Date</th>}
              {cols.due && <th>Due date</th>}
              {cols.status && <th>Status</th>}
              {cols.total && <th className="num">Total</th>}
              {cols.amount_due && <th className="num">Outstanding</th>}
            </tr></thead>
            <tbody>
              {pager.slice.map((d: any) => (
                <tr key={d.id} className={`click${selected.has(d.id) ? ' row-selected' : ''}`} {...rowActivate(() => setViewing(d.id))}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" aria-label={`Select ${d.invoice_number}`} checked={selected.has(d.id)} onChange={() => toggle(d.id)} />
                  </td>
                  <td><strong>{d.invoice_number}</strong>{d.reference && <div className="faint small">{d.reference}</div>}</td>
                  {cols.contact && <td>{d.contact_name}</td>}
                  {cols.date && <td>{fmtDate(d.date)}</td>}
                  {cols.due && <td style={{ color: d.status === 'AUTHORISED' && d.due_date < new Date().toISOString().slice(0, 10) ? 'var(--red)' : undefined }}>{fmtDate(d.due_date)}</td>}
                  {cols.status && <td><Badge status={d.status} /></td>}
                  {cols.total && <td className="num"><Money cents={d.total} currency={d.currency_code} /></td>}
                  {cols.amount_due && <td className="num"><Money cents={d.amount_due} currency={d.currency_code} /></td>}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data && data.length > 0 && <Pager pager={pager} noun="documents" />}
      </div>
      {confirmVoid && (
        <ConfirmDanger
          title={`Void ${selArr.filter((id) => { const d = selById(id); return d && d.status !== 'VOIDED' && d.status !== 'DELETED' && !(d.amount_paid > 0); }).length} document(s)?`}
          lines={[
            'Draft documents will be deleted; approved ones will be reversed out of your accounts.',
            'Part-paid documents are skipped automatically — raise a credit note for those.',
            'This cannot be undone in bulk.',
          ]}
          confirmLabel="Void selected"
          onClose={() => setConfirmVoid(false)}
          onConfirm={doVoid}
        />
      )}
      {editing && <DocumentEditor kind={kind} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); reload(); }} />}
      {viewing != null && <DocumentViewer kind={kind} docId={viewing} onClose={() => setViewing(null)} onChanged={reload} />}
    </>
  );
}

function QuoteList() {
  const { data, reload } = useApi<any[]>('invoices.listQuotes');
  const [editing, setEditing] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  return (
    <>
      <div className="page-head">
        <div className="grow" />
        <button className="btn primary" onClick={() => setEditing(true)}>+ New quote</button>
      </div>
      <div className="card tight">
        {data && data.length === 0 ? (
          <Empty title="No quotes yet" />
        ) : (
          <table className="tbl">
            <thead><tr><th>Number</th><th>To</th><th>Title</th><th>Date</th><th>Expiry</th><th>Status</th><th className="num">Total</th></tr></thead>
            <tbody>
              {(data ?? []).map((q) => (
                <tr key={q.id} className="click" onClick={() => setViewing(q.id)}>
                  <td><strong>{q.quote_number}</strong></td>
                  <td>{q.contact_name}</td>
                  <td>{q.title}</td>
                  <td>{fmtDate(q.date)}</td>
                  <td>{fmtDate(q.expiry_date)}</td>
                  <td><Badge status={q.status} /></td>
                  <td className="num"><Money cents={q.total} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editing && <DocumentEditor kind="QUOTE" onClose={() => setEditing(false)} onSaved={() => { setEditing(false); reload(); }} />}
      {viewing != null && <DocumentViewer kind="QUOTE" docId={viewing} onClose={() => setViewing(null)} onChanged={reload} />}
    </>
  );
}

function RepeatingList() {
  const { data } = useApi<any[]>('invoices.listRepeating');
  return (
    <div className="card tight">
      {data && data.length === 0 ? (
        <Empty title="No repeating invoices" sub="Templates here generate invoices automatically on schedule." />
      ) : (
        <table className="tbl">
          <thead><tr><th>Contact</th><th>Reference</th><th>Every</th><th>Next run</th><th>Saves as</th></tr></thead>
          <tbody>
            {(data ?? []).map((r) => (
              <tr key={r.id}>
                <td><strong>{r.contact_name}</strong></td>
                <td>{r.reference}</td>
                <td>{r.interval_n} {r.unit.toLowerCase()}{r.interval_n > 1 ? 's' : ''}</td>
                <td>{fmtDate(r.next_run_date)}</td>
                <td><Badge status={r.save_as} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
