/**
 * Shared editor & viewer for every document type: invoices (ACCREC), bills
 * (ACCPAY), credit notes (ACCRECCREDIT/ACCPAYCREDIT), quotes and purchase
 * orders — exactly the Xero pattern of one screen, many document types.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { api, money, toCents, fromCents, todayIso, addDays, exportPdf, fmtDate, dateError, emailError } from '../api';
import { useApi, useToast, Modal, Field, PickContact, PickAccount, PickTaxRate, PickProject, Money, Badge, ErrorBanner, Spinner, useTrackingCategories, TrackingSelects, ConfirmDanger, SearchSelect, DocHistory, DateField, EmailField } from '../components';
import { Attachments } from '../Attachments';

export type DocKind = 'ACCREC' | 'ACCPAY' | 'ACCRECCREDIT' | 'ACCPAYCREDIT' | 'QUOTE' | 'PO';

const KIND_LABEL: Record<DocKind, string> = {
  ACCREC: 'Invoice', ACCPAY: 'Bill', ACCRECCREDIT: 'Credit note', ACCPAYCREDIT: 'Supplier credit', QUOTE: 'Quote', PO: 'Purchase order',
};

interface LineDraft {
  item_id: number | '';
  description: string;
  quantity: string;
  unit_amount: string; // dollars text
  discount_percent: string;
  account_id: number | '';
  tax_rate_id: number | null;
  tracking_option_1: number | null;
  tracking_option_2: number | null;
  project_id: number | null;
}

const blankLine = (): LineDraft => ({ item_id: '', description: '', quantity: '1', unit_amount: '', discount_percent: '', account_id: '', tax_rate_id: null, tracking_option_1: null, tracking_option_2: null, project_id: null });

function rate(taxRates: any[], id: number | null): number {
  if (!id) return 0;
  return (taxRates.find((t) => t.id === id)?.display_rate ?? 0) / 100;
}

function lineTotals(l: LineDraft, mode: string, taxRates: any[]) {
  const qty = parseFloat(l.quantity) || 0;
  const unit = toCents(l.unit_amount);
  const disc = parseFloat(l.discount_percent) || 0;
  const amount = Math.round(qty * unit * (1 - disc / 100));
  const r = rate(taxRates, l.tax_rate_id);
  if (mode === 'NOTAX') return { net: amount, tax: 0 };
  if (mode === 'EXCLUSIVE') return { net: amount, tax: Math.round(amount * r) };
  const net = Math.round(amount / (1 + r));
  return { net, tax: amount - net };
}

export function DocumentEditor({ kind, docId, copyFrom, onClose, onSaved }: { kind: DocKind; docId?: number; copyFrom?: number; onClose: () => void; onSaved: (id: number) => void }) {
  const isSale = kind === 'ACCREC' || kind === 'ACCRECCREDIT' || kind === 'QUOTE';
  const isQuote = kind === 'QUOTE';
  const isPO = kind === 'PO';
  const { data: taxRates } = useApi<any[]>('settings.listTaxRates');
  const { data: items } = useApi<any[]>('items.list', {});
  const trackingCats = useTrackingCategories();
  const showTracking = !isQuote && !isPO && trackingCats.length > 0;
  const showProject = kind === 'ACCREC' || kind === 'ACCPAY' || kind === 'ACCPAYCREDIT' || kind === 'ACCRECCREDIT';
  const toast = useToast();

  const [contact, setContact] = useState<number | ''>('');
  const [date, setDate] = useState(todayIso());
  const [due, setDue] = useState(addDays(todayIso(), 14));
  const [ref, setRef] = useState('');
  const [mode, setMode] = useState<string>(() => { try { return localStorage.getItem('bob-line-amount-mode') || 'EXCLUSIVE'; } catch { return 'EXCLUSIVE'; } });
  const [lines, setLines] = useState<LineDraft[]>([blankLine(), blankLine()]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Leave-without-saving guard. A copy is "dirty" the moment it opens —
  // it holds real content that exists nowhere else yet.
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const serialize = () => JSON.stringify({ contact, date, due, ref, mode, lines });
  // Autosave only applies to a brand-new document (no docId, not a copy):
  // those exist nowhere yet, so a tab crash would lose them. Edits and copies
  // are excluded to keep things predictable.
  const isNewDoc = !docId && !copyFrom;
  const draftKey = `bob-wip-${kind}`;
  const [recovered, setRecovered] = useState<{ when: string } | null>(null);
  function clearWip() { try { localStorage.removeItem(draftKey); } catch { /* ignore */ } }

  useEffect(() => {
    if (!docId && !copyFrom) { setSnapshot(JSON.stringify({ contact: '', date, due, ref: '', mode: 'EXCLUSIVE', lines: [blankLine(), blankLine()] })); return; }
    const path = isQuote ? 'invoices.getQuote' : isPO ? 'invoices.getPO' : 'invoices.get';
    api(path, docId ?? copyFrom).then((d: any) => {
      setContact(d.contact_id);
      if (copyFrom) {
        // Copy everything EXCEPT the dates — they start blank so the copy
        // can't accidentally inherit the original's posted date.
        setDate('');
        setDue('');
      } else {
        setDate(d.date);
        setDue(d.due_date ?? d.expiry_date ?? d.delivery_date ?? addDays(d.date, 14));
      }
      setRef(d.reference ?? d.title ?? '');
      setMode(d.line_amount_type ?? 'EXCLUSIVE');
      setLines(
        d.lines.map((l: any) => ({
          item_id: l.item_id ?? '',
          description: l.description ?? '',
          quantity: String(l.quantity ?? 1),
          unit_amount: fromCents(l.unit_amount ?? 0),
          discount_percent: l.discount_percent ? String(l.discount_percent) : '',
          account_id: l.account_id ?? '',
          tax_rate_id: l.tax_rate_id ?? null,
          tracking_option_1: l.tracking_option_1 ?? null,
          tracking_option_2: l.tracking_option_2 ?? null,
          project_id: l.project_id ?? null,
        }))
      );
      if (!copyFrom) {
        // Editing something that already exists: only nag if it changed.
        setTimeout(() => setSnapshot((prev) => prev ?? null), 0);
      }
    }).catch((e) => setErr(e.message));
  }, [docId, copyFrom]);

  // Offer to recover an unsaved working draft for a brand-new document.
  useEffect(() => {
    if (!isNewDoc) return;
    try {
      const raw = localStorage.getItem(draftKey);
      if (!raw) return;
      const saved = JSON.parse(raw);
      // Only offer if there's meaningful content (a contact or a real line).
      const hasContent = saved.contact || (saved.lines ?? []).some((l: any) => (l.description || '').trim() || l.account_id);
      if (hasContent) setRecovered({ when: saved._savedAt ?? '' });
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Autosave the working draft as it changes (debounced), for new docs only.
  useEffect(() => {
    if (!isNewDoc || recovered) return; // don't overwrite a draft we're offering to restore
    const hasContent = contact !== '' || lines.some((l) => l.description.trim() || l.account_id);
    if (!hasContent) return;
    const t = setTimeout(() => {
      try { localStorage.setItem(draftKey, JSON.stringify({ contact, date, due, ref, mode, lines, _savedAt: new Date().toISOString() })); } catch { /* ignore */ }
    }, 600);
    return () => clearTimeout(t);
  }, [contact, date, due, ref, mode, lines, isNewDoc, recovered, draftKey]);

  function restoreDraft() {
    try {
      const saved = JSON.parse(localStorage.getItem(draftKey) || '{}');
      if (saved.contact !== undefined) setContact(saved.contact);
      if (saved.date !== undefined) setDate(dateError(saved.date) ? '' : saved.date);
      if (saved.due !== undefined) setDue(dateError(saved.due) ? '' : saved.due);
      if (saved.ref !== undefined) setRef(saved.ref);
      if (saved.mode !== undefined) setMode(saved.mode);
      if (Array.isArray(saved.lines) && saved.lines.length) setLines(saved.lines);
    } catch { /* ignore */ }
    setRecovered(null);
  }
  function discardDraft() { clearWip(); setRecovered(null); }

  // Take the post-load snapshot once state has settled (existing docs only).
  useEffect(() => {
    if (copyFrom || snapshot != null) return;
    if (docId && contact !== '') setSnapshot(serialize());
  }, [contact, date, due, ref, mode, lines, docId, copyFrom, snapshot]);

  const dirty = !!copyFrom || (snapshot != null && serialize() !== snapshot);
  function guardedClose() {
    if (!dirty || busy) return onClose();
    setConfirmLeave(true);
  }

  const totals = useMemo(() => {
    const ts = lines.filter((l) => l.description || l.unit_amount).map((l) => lineTotals(l, mode, taxRates ?? []));
    const subtotal = ts.reduce((s, t) => s + t.net, 0);
    const tax = ts.reduce((s, t) => s + t.tax, 0);
    return { subtotal, tax, total: subtotal + tax };
  }, [lines, mode, taxRates]);

  const setLine = (i: number, patch: Partial<LineDraft>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const applyItem = (i: number, itemId: number | '') => {
    const it = (items ?? []).find((x: any) => x.id === itemId);
    if (!it) return setLine(i, { item_id: itemId });
    setLine(i, {
      item_id: itemId,
      description: (isSale ? it.description_sales : it.description_purchase) ?? it.name,
      unit_amount: fromCents((isSale ? it.sales_unit_price : it.purchase_unit_price) ?? 0),
      account_id: (isSale ? it.sales_account_id : it.purchase_account_id ?? it.cogs_account_id) ?? '',
      tax_rate_id: (isSale ? it.sales_tax_rate_id : it.purchase_tax_rate_id) ?? null,
    });
  };

  async function save(thenApprove: boolean) {
    setErr(null);
    if (!contact) return setErr('Choose a contact');
    if (!date) return setErr('Pick a date — copies start with it blank on purpose');
    const dErr = dateError(date, 'date') || dateError(due, 'due date');
    if (dErr) return setErr(dErr);
    const body = lines
      .filter((l) => l.description.trim() && l.account_id)
      .map((l) => ({
        item_id: l.item_id || null,
        description: l.description,
        quantity: parseFloat(l.quantity) || 1,
        unit_amount: toCents(l.unit_amount),
        discount_percent: parseFloat(l.discount_percent) || 0,
        account_id: l.account_id as number,
        tax_rate_id: l.tax_rate_id,
        tracking_option_1: l.tracking_option_1,
        tracking_option_2: l.tracking_option_2,
        project_id: showProject ? l.project_id : null,
      }));
    if (!body.length) return setErr('Add at least one line with a description and an account');
    setBusy(true);
    try {
      let id: number;
      if (isQuote) {
        const q = await api('invoices.saveQuote', { id: docId, contact_id: contact, date, expiry_date: due, title: ref, line_amount_type: mode, lines: body });
        id = q.id;
      } else if (isPO) {
        const p = await api('invoices.savePO', { id: docId, contact_id: contact, date, delivery_date: due, reference: ref, line_amount_type: mode, lines: body });
        id = p.id;
      } else {
        const d = await api('invoices.saveDraft', { id: docId, type: kind, contact_id: contact, date, due_date: due, reference: ref, line_amount_type: mode, lines: body });
        id = d.id;
        if (thenApprove) await api('invoices.approve', id);
      }
      clearWip();
      toast(`${KIND_LABEL[kind]} ${thenApprove ? 'approved' : 'saved'}`);
      onSaved(id);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`${docId ? 'Edit' : copyFrom ? 'Copy of' : 'New'} ${KIND_LABEL[kind].toLowerCase()}`} wide onClose={guardedClose}>
      <ErrorBanner msg={err} />
      {recovered && (
        <div className="recover-bar">
          <span>↩︎ You have an unsaved {KIND_LABEL[kind].toLowerCase()} from a previous session{recovered.when ? ` (${fmtDate(recovered.when.slice(0, 10))})` : ''}. Restore it?</span>
          <span style={{ flex: 1 }} />
          <button className="btn small primary" onClick={restoreDraft}>Restore</button>
          <button className="btn small" onClick={discardDraft}>Discard</button>
        </div>
      )}
      <div className="form-row">
        <Field label={isSale ? 'Customer' : 'Supplier'} grow={1.7}>
          <PickContact value={contact} onChange={setContact} filter={isSale ? 'CUSTOMERS' : 'SUPPLIERS'} />
        </Field>
        <Field label="Date"><DateField value={date} onChange={setDate} label="date" /></Field>
        <Field label={isQuote ? 'Expiry' : isPO ? 'Delivery date' : 'Due date'}>
          <DateField value={due} onChange={setDue} label="due date" />
        </Field>
        <Field label={isQuote ? 'Title' : 'Reference'} grow={1.3}><input value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
        <Field label="Amounts are">
          <select value={mode} onChange={(e) => { setMode(e.target.value); try { localStorage.setItem('bob-line-amount-mode', e.target.value); } catch { /* ignore */ } }}>
            <option value="EXCLUSIVE">Tax exclusive</option>
            <option value="INCLUSIVE">Tax inclusive</option>
            <option value="NOTAX">No tax</option>
          </select>
        </Field>
      </div>

      <table className="tbl">
        <thead>
          <tr>
            <th style={{ width: 130 }}>Item</th><th>Description</th><th style={{ width: 70 }}>Qty</th>
            <th style={{ width: 100 }}>Unit price</th><th style={{ width: 70 }}>Disc %</th>
            <th style={{ width: 180 }}>Account</th><th style={{ width: 150 }}>Tax rate</th>
            {showTracking && <th style={{ width: 150 }}>Tracking</th>}
            {showProject && <th style={{ width: 150 }}>Project</th>}
            <th className="num" style={{ width: 100 }}>Amount</th><th style={{ width: 30 }} />
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td>
                <SearchSelect
                  value={l.item_id}
                  onChange={(id) => applyItem(i, id || '')}
                  options={(items ?? [])
                    .filter((it: any) => (isSale || isQuote ? it.i_sell : it.i_purchase))
                    .map((it: any) => ({ id: it.id, label: `${it.code} — ${it.name}` }))}
                  placeholder="Item…"
                />
              </td>
              <td><input value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} /></td>
              <td><input className="num" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} /></td>
              <td><input className="num" value={l.unit_amount} onChange={(e) => setLine(i, { unit_amount: e.target.value })} placeholder="0.00" /></td>
              <td><input className="num" value={l.discount_percent} onChange={(e) => setLine(i, { discount_percent: e.target.value })} /></td>
              <td><PickAccount value={l.account_id} onChange={(id) => setLine(i, { account_id: id })} /></td>
              <td><PickTaxRate value={l.tax_rate_id} onChange={(id) => setLine(i, { tax_rate_id: id })} side={isSale ? 'sales' : 'purchases'} /></td>
              {showTracking && (
                <td>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <TrackingSelects
                      categories={trackingCats}
                      value1={l.tracking_option_1}
                      value2={l.tracking_option_2}
                      onChange={(v1, v2) => setLine(i, { tracking_option_1: v1, tracking_option_2: v2 })}
                    />
                  </div>
                </td>
              )}
              {showProject && (
                <td><PickProject value={l.project_id} onChange={(pid) => setLine(i, { project_id: pid })} /></td>
              )}
              <td className="num">{money(lineTotals(l, mode, taxRates ?? []).net)}</td>
              <td><button type="button" className="icon-btn" aria-label="Remove this line" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} title="Remove">✕</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ marginTop: 10 }}>
        <button className="btn small" onClick={() => setLines((ls) => {
          // Inherit account + tax from the line above so repeat entry is fast.
          const prev = [...ls].reverse().find((l) => l.account_id || l.tax_rate_id != null);
          const seed = blankLine();
          if (prev) { seed.account_id = prev.account_id; seed.tax_rate_id = prev.tax_rate_id; }
          return [...ls, seed];
        })}>+ Add line</button>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
        <div className="kv" style={{ width: 280 }}>
          <span className="k">Subtotal</span><span className="right">{money(totals.subtotal)}</span>
          <span className="k">Total tax</span><span className="right">{money(totals.tax)}</span>
          <span className="k" style={{ fontWeight: 650 }}>Total</span><span className="right" style={{ fontWeight: 650 }}>{money(totals.total)}</span>
        </div>
      </div>

      <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 18 }}>
        <button className="btn" onClick={guardedClose}>Cancel</button>
        <button className="btn" disabled={busy} onClick={() => save(false)}>Save draft</button>
        {!isQuote && !isPO && (
          <button className="btn primary" disabled={busy} onClick={() => save(true)}>Approve</button>
        )}
      </div>
      {confirmLeave && (
        <Modal title="Leave without saving?" onClose={() => setConfirmLeave(false)}>
          <p>{copyFrom
            ? 'This copy hasn\u2019t been saved anywhere yet \u2014 if you leave now, it simply never existed.'
            : 'You\u2019ve made changes that aren\u2019t saved.'}</p>
          <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
            <button type="button" className="btn" onClick={() => setConfirmLeave(false)}>Keep editing</button>
            <button type="button" className="btn danger" onClick={() => { setConfirmLeave(false); onClose(); }}>Discard</button>
            <button type="button" className="btn primary" disabled={busy} onClick={async () => { setConfirmLeave(false); await save(false); }}>Save as draft</button>
          </div>
        </Modal>
      )}
    </Modal>
  );
}

// ── Viewer ───────────────────────────────────────────────────────────────

export function DocumentViewer({ kind, docId, onClose, onChanged }: { kind: DocKind; docId: number; onClose: () => void; onChanged: () => void }) {
  const isQuote = kind === 'QUOTE';
  const isPO = kind === 'PO';
  const path = isQuote ? 'invoices.getQuote' : isPO ? 'invoices.getPO' : 'invoices.get';
  const { data: doc, reload } = useApi<any>(path, docId);
  const { data: org } = useApi<any>('settings.getOrganisation');
  const { data: appState, reload: reloadApproval } = useApi<any>('approvals.state', docId);
  const toast = useToast();
  const [err, setErr] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [editing, setEditing] = useState(false);
  const [copyAs, setCopyAs] = useState<boolean>(false);
  const [progressing, setProgressing] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [emailing, setEmailing] = useState(false);

  if (!doc) return null;
  const isSale = doc.type === 'ACCREC' || doc.type === 'ACCRECCREDIT' || isQuote;
  const number = doc.invoice_number ?? doc.quote_number ?? doc.order_number;
  const label = KIND_LABEL[(doc.type as DocKind) ?? kind];

  const act = (fn: () => Promise<any>, msg: string) => async () => {
    setErr(null);
    try {
      await fn();
      toast(msg);
      reload();
      onChanged();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  async function pdf() {
    const html = renderDocumentHtml(doc, org, label);
    const r = await exportPdf(html, `${number ?? label}.pdf`);
    if (r.ok) toast('PDF saved');
    else if (r.error !== 'cancelled') setErr(r.error ?? 'PDF failed');
  }

  return (
    <Modal title={`${label} ${number ?? ''}`} wide onClose={onClose}>
      <ErrorBanner msg={err} />
      <div style={{ display: 'flex', gap: 18, marginBottom: 14, alignItems: 'center' }}>
        <Badge status={doc.status} />
        <span><strong>{doc.contact_name}</strong></span>
        <span className="muted">{fmtDate(doc.date)}</span>
        {doc.due_date && <span className="muted">due {fmtDate(doc.due_date)}</span>}
        {doc.reference && <span className="muted">ref {doc.reference}</span>}
        {doc.currency_code && doc.currency_code !== 'USD' && <span className="badge blue">{doc.currency_code} @ {doc.exchange_rate}</span>}
        <span className="spacer" style={{ flex: 1 }} />
        <button className="btn small" onClick={() => setEmailing(true)}>✉ Email</button>
        <button className="btn small" onClick={pdf}>Export PDF</button>
      </div>

      <table className="tbl">
        <thead><tr><th>Description</th><th>Account</th><th className="num">Qty</th><th className="num">Unit</th><th className="num">Tax</th><th className="num">Amount</th></tr></thead>
        <tbody>
          {doc.lines.map((l: any) => (
            <tr key={l.id}>
              <td>
                {l.description}
                {(l.tracking_1 || l.tracking_2) && <div className="faint small">{[l.tracking_1, l.tracking_2].filter(Boolean).join(' · ')}</div>}
              </td>
              <td className="small">{l.account_code} {l.account_name}{l.tax_rate_name ? <div className="faint small">{l.tax_rate_name}</div> : null}</td>
              <td className="num">{l.quantity}</td>
              <td className="num">{money(l.unit_amount, doc.currency_code)}</td>
              <td className="num">{money(l.tax_amount ?? 0, doc.currency_code)}</td>
              <td className="num">{money(l.line_amount, doc.currency_code)}</td>
            </tr>
          ))}
          <tr className="total"><td colSpan={5}>Total {doc.total_tax ? `(incl. ${money(doc.total_tax, doc.currency_code)} tax)` : ''}</td><td className="num">{money(doc.total, doc.currency_code)}</td></tr>
          {doc.amount_due != null && doc.status !== 'DRAFT' && (
            <tr><td colSpan={5} className="right muted">Amount due</td><td className="num"><strong>{money(doc.amount_due, doc.currency_code)}</strong></td></tr>
          )}
        </tbody>
      </table>

      {!isQuote && !isPO && <Attachments entityType="invoice" entityId={docId} />}
      {!isQuote && !isPO && <DocHistory source="INVOICE" docId={docId} />}
      {!isQuote && !isPO && appState?.requires && (
        <ApprovalPanel docId={docId} state={appState} onChanged={() => { reload(); reloadApproval(); }} />
      )}

      <div className="btn-row" style={{ marginTop: 18 }}>
        {isQuote && doc.status === 'DRAFT' && <button className="btn" onClick={act(() => api('invoices.setQuoteStatus', docId, 'SENT'), 'Quote sent')}>Mark sent</button>}
        {isQuote && ['SENT', 'DRAFT'].includes(doc.status) && (
          <>
            <button className="btn" onClick={() => setEditing(true)}>Edit</button>
            <button className="btn" onClick={act(() => api('invoices.setQuoteStatus', docId, 'ACCEPTED'), 'Quote accepted')}>Mark accepted</button>
            <button className="btn danger" onClick={act(() => api('invoices.setQuoteStatus', docId, 'DECLINED'), 'Quote declined')}>Decline</button>
          </>
        )}
        {isQuote && doc.status === 'ACCEPTED' && <button className="btn primary" onClick={act(() => api('invoices.quoteToInvoice', docId), 'Invoice created from quote')}>Create invoice</button>}
        {isQuote && doc.status === 'ACCEPTED' && <button className="btn" onClick={() => setProgressing(true)}>Progress invoice</button>}
        {isPO && doc.status === 'DRAFT' && (
          <>
            <button className="btn" onClick={() => setEditing(true)}>Edit</button>
            <button className="btn" onClick={act(() => api('invoices.setPOStatus', docId, 'APPROVED'), 'PO approved')}>Approve</button>
          </>
        )}
        {isPO && doc.status === 'APPROVED' && <button className="btn primary" onClick={act(() => api('invoices.poToBill', docId), 'Bill created from PO')}>Create bill</button>}

        {!isQuote && !isPO && (
          <>
            {['DRAFT', 'SUBMITTED'].includes(doc.status) && (
              <>
                <button className="btn" onClick={() => setEditing(true)}>Edit</button>
                {!appState?.requires && <button className="btn primary" onClick={act(() => api('invoices.approve', docId), 'Approved')}>Approve</button>}
              </>
            )}
            {doc.status === 'AUTHORISED' && (
              <button
                className="btn"
                title="Reverses the postings and reopens this document as a draft for editing — keeps its number"
                onClick={async () => {
                  setErr(null);
                  try {
                    await api('invoices.revertToDraft', docId);
                    toast('Reopened as draft — make your changes and re-approve');
                    reload();
                    onChanged();
                    setEditing(true);
                  } catch (e: any) { setErr(e.message); }
                }}
              >
                Edit
              </button>
            )}
            {['AUTHORISED', 'PAID', 'DRAFT', 'SUBMITTED'].includes(doc.status) && (
              <button
                className="btn"
                title="Open a copy with the same lines — nothing is saved until you choose"
                onClick={() => setCopyAs(true)}
              >
                Copy
              </button>
            )}
            {doc.status === 'AUTHORISED' && !doc.type.endsWith('CREDIT') && (
              <button className="btn primary" onClick={() => setPaying(true)}>{isSale ? 'Receive payment' : 'Pay bill'}</button>
            )}
            {['DRAFT', 'SUBMITTED', 'AUTHORISED'].includes(doc.status) && (
              <button className="btn danger" onClick={() => setVoiding(true)}>
                {doc.status === 'AUTHORISED' ? 'Void' : 'Delete draft'}
              </button>
            )}
          </>
        )}
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={onClose}>Close</button>
      </div>

      {paying && (
        <PaymentModal
          doc={doc}
          onClose={() => setPaying(false)}
          onDone={() => { setPaying(false); reload(); onChanged(); }}
        />
      )}
      {editing && (
        <DocumentEditor kind={(doc.type as DocKind) ?? kind} docId={docId} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); reload(); onChanged(); }} />
      )}
      {emailing && (
        <EmailDialog
          kind={(doc.type as DocKind) ?? kind}
          docId={docId}
          pdfHtml={renderDocumentHtml(doc, org, label)}
          onClose={() => setEmailing(false)}
        />
      )}
      {copyAs && (
        <DocumentEditor kind={doc.type} copyFrom={docId} onClose={() => setCopyAs(false)} onSaved={() => { setCopyAs(false); reload(); onChanged(); }} />
      )}
      {progressing && (
        <ProgressInvoiceModal quoteId={docId} onClose={() => setProgressing(false)} onDone={() => { setProgressing(false); reload(); onChanged(); }} />
      )}
      {voiding && doc.status === 'AUTHORISED' && (
        <ConfirmDanger
          title={`Void ${label.toLowerCase()} ${number ?? ''}?`}
          lines={[
            `${label} ${number ?? ''} — ${doc.contact_name}, ${money(doc.total, doc.currency_code)} — will be marked VOIDED.`,
            'Its postings to the ledger will be reversed, so every report updates.',
            'Stock movements from tracked items on this document are reversed too.',
            'The document and its number stay visible for your audit trail, but it can’t be un-voided.',
          ]}
          ack="I understand this reverses the accounting entries and can’t be undone."
          confirmLabel={`Void ${label.toLowerCase()}`}
          onConfirm={async () => { await api('invoices.voidDoc', docId); toast('Voided'); reload(); onChanged(); }}
          onClose={() => setVoiding(false)}
        />
      )}
      {voiding && doc.status !== 'AUTHORISED' && (
        <ConfirmDanger
          title={`Delete this draft ${label.toLowerCase()}?`}
          lines={[
            'This draft has never posted to your ledger, so no figures change.',
            'It will disappear from your lists and can’t be recovered.',
          ]}
          confirmLabel="Delete draft"
          onConfirm={async () => { await api('invoices.voidDoc', docId); toast('Draft deleted'); onChanged(); onClose(); }}
          onClose={() => setVoiding(false)}
        />
      )}
    </Modal>
  );
}

function PaymentModal({ doc, onClose, onDone }: { doc: any; onClose: () => void; onDone: () => void }) {
  const { data: banks } = useApi<any[]>('banking.accounts');
  const toast = useToast();
  const [bank, setBank] = useState<number | ''>('');
  const [date, setDate] = useState(todayIso());
  const [amount, setAmount] = useState(fromCents(doc.amount_due));
  const [rate, setRate] = useState(String(doc.exchange_rate ?? 1));
  const [ref, setRef] = useState(doc.invoice_number ?? '');
  const [err, setErr] = useState<string | null>(null);
  const isSale = doc.type === 'ACCREC';
  const side = isSale ? 'CUSTOMER' : 'SUPPLIER';
  const isBase = !doc.currency_code || doc.currency_code === 'USD';
  const { data: onAccount } = useApi<number>('payments.prepaymentBalance', doc.contact_id, side);
  useEffect(() => { if (banks?.length && !bank) setBank(banks[0].id); }, [banks]);

  const docCurrency = doc.currency_code || 'USD';
  const selectedBank = (banks ?? []).find((b: any) => b.id === bank);
  const bankCurrency = selectedBank?.bank_currency || 'USD';
  // Cross-currency: the chosen bank account holds a different currency than the document.
  const crossCurrency = !!selectedBank && bankCurrency !== docCurrency;
  const [bankAmount, setBankAmount] = useState('');   // amount in the bank's currency
  const [bankRate, setBankRate] = useState('1');       // bank currency → base

  const amtCents = toCents(amount || '0');
  const overpay = amtCents - doc.amount_due; // in document currency

  async function submit() {
    setErr(null);
    try {
      if (crossCurrency) {
        // Settle the document in its own currency; the bank moves bankAmount in its currency.
        await api('payments.create', {
          type: isSale ? 'RECEIVE' : 'SPEND',
          date, bank_account_id: bank, contact_id: doc.contact_id,
          amount: 0, bank_amount: toCents(bankAmount || '0'), bank_rate: parseFloat(bankRate) || 1,
          reference: ref,
          allocations: [{ invoice_id: doc.id, amount: Math.min(amtCents, doc.amount_due) }],
        });
        toast('Cross-currency payment recorded');
        onDone();
        return;
      }
      // Allocate up to what's owed; any excess is recorded as money on account.
      const alloc = Math.min(amtCents, doc.amount_due);
      await api('payments.create', {
        type: isSale ? 'RECEIVE' : 'SPEND',
        date, bank_account_id: bank, contact_id: doc.contact_id,
        amount: amtCents, currency_code: doc.currency_code, exchange_rate: parseFloat(rate) || 1,
        reference: ref,
        allocations: alloc > 0 ? [{ invoice_id: doc.id, amount: alloc }] : [],
      });
      toast(overpay > 0 ? 'Payment recorded — excess kept on account' : 'Payment recorded');
      onDone();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  async function applyOnAccount() {
    setErr(null);
    try {
      const use = Math.min(onAccount ?? 0, doc.amount_due);
      await api('payments.applyPrepayment', { contact_id: doc.contact_id, invoice_id: doc.id, amount: use, date });
      toast('Money on account applied');
      onDone();
    } catch (e: any) { setErr(e.message); }
  }

  return (
    <Modal title={isSale ? 'Receive payment' : 'Pay bill'} onClose={onClose}>
      <ErrorBanner msg={err} />
      {(onAccount ?? 0) > 0 && isBase && (
        <div className="info-bar" style={{ marginBottom: 12 }}>
          This contact has <strong><Money cents={onAccount!} /></strong> on account.{' '}
          <a onClick={applyOnAccount} style={{ cursor: 'pointer', fontWeight: 600 }}>Apply <Money cents={Math.min(onAccount!, doc.amount_due)} /> to this {isSale ? 'invoice' : 'bill'}</a>
        </div>
      )}
      <div className="form-row">
        <Field label="Bank account">
          <select value={bank} onChange={(e) => setBank(Number(e.target.value))}>
            {(banks ?? []).map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </Field>
        <Field label="Date"><DateField value={date} onChange={setDate} label="date" /></Field>
      </div>
      <div className="form-row">
        <Field label={`Amount (${docCurrency})`}><input className="num" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        {!crossCurrency && doc.currency_code !== 'USD' && <Field label="Exchange rate"><input className="num" value={rate} onChange={(e) => setRate(e.target.value)} /></Field>}
        <Field label="Reference"><input value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
      </div>
      {crossCurrency && (
        <div className="info-bar" style={{ marginBottom: 12 }}>
          <p className="small" style={{ margin: '0 0 8px' }}>
            This {isSale ? 'invoice' : 'bill'} is in <strong>{docCurrency}</strong> but the bank account holds <strong>{bankCurrency}</strong>.
            Enter what actually moved through the bank — the difference is recorded as a realised currency gain or loss.
          </p>
          <div className="form-row">
            <Field label={`Amount from bank (${bankCurrency})`}><input className="num" value={bankAmount} onChange={(e) => setBankAmount(e.target.value)} placeholder="0.00" /></Field>
            {bankCurrency !== 'USD' && <Field label={`${bankCurrency} → USD rate`}><input className="num" value={bankRate} onChange={(e) => setBankRate(e.target.value)} /></Field>}
          </div>
        </div>
      )}
      {overpay > 0 && !crossCurrency && (
        <p className="muted small" style={{ marginTop: -4 }}>
          That’s more than the {isSale ? 'invoice' : 'bill'} balance — <strong><Money cents={overpay} /></strong> will be recorded as money on account for this contact.
        </p>
      )}
      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={submit}>Record payment</button>
      </div>
    </Modal>
  );
}

/** Branded printable HTML for PDF export. */
export function renderDocumentHtml(doc: any, org: any, label: string): string {
  const cur = doc.currency_code ?? 'USD';
  const m = (c: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format((c ?? 0) / 100);
  const isCredit = doc.type === 'ACCRECCREDIT' || doc.type === 'ACCPAYCREDIT';
  const isSale = doc.type === 'ACCREC' || doc.type === 'ACCRECCREDIT' || label.toLowerCase().includes('quote');
  const number = doc.invoice_number ?? doc.quote_number ?? doc.order_number ?? '';

  const hasTax = (doc.lines ?? []).some((l: any) => (l.tax_amount ?? 0) !== 0);
  const rows = (doc.lines ?? []).map((l: any) => `
    <tr>
      <td>
        <div class="desc">${esc(l.description)}</div>
        ${(l.tracking_1 || l.tracking_2) ? `<div class="sub">${esc([l.tracking_1, l.tracking_2].filter(Boolean).join(' · '))}</div>` : ''}
      </td>
      <td class="acct">${esc([l.account_code, l.account_name].filter(Boolean).join(' '))}</td>
      <td class="n">${l.quantity}</td>
      <td class="n">${m(l.unit_amount)}</td>
      ${hasTax ? `<td class="n">${m(l.tax_amount ?? 0)}</td>` : ''}
      <td class="n">${m(l.line_amount)}</td>
    </tr>`).join('');

  // Letterhead address block from the org's saved details.
  const orgAddr = [org?.address_line1, org?.address_line2, [org?.address_city, org?.address_region, org?.address_postcode].filter(Boolean).join(' '), org?.address_country]
    .filter(Boolean).map((x: string) => esc(x)).join('<br>');
  const orgContact = [org?.contact_phone && `Tel ${esc(org.contact_phone)}`, org?.contact_email && esc(org.contact_email), org?.website && esc(org.website)].filter(Boolean).join(' &nbsp;·&nbsp; ');

  // Recipient ("Bill to" / "From") block with address.
  const a = doc.contact_address;
  const recipientAddr = a ? [a.line1, a.line2, [a.city, a.region, a.postcode].filter(Boolean).join(' '), a.country].filter(Boolean).map((x: string) => esc(x)).join('<br>') : '';
  const recipientContact = [doc.contact_email && esc(doc.contact_email), doc.contact_phone && esc(doc.contact_phone)].filter(Boolean).join(' · ');
  const isPurchaseOrder = label.toLowerCase().includes('purchase order');
  const recipientLabel = isPurchaseOrder ? 'Order to' : isCredit ? (isSale ? 'Credit to' : 'Credit from') : (isSale ? 'Bill to' : 'From');

  const paid = (doc.payments ?? []).reduce((s: number, p: any) => s + (p.amount ?? 0), 0)
    + (doc.credits ?? []).reduce((s: number, c: any) => s + (c.amount ?? 0), 0);

  const orgName = esc(org?.trading_name || org?.legal_name || 'Your business');
  const logo = org?.logo_data ? `<img src="${String(org.logo_data).replace(/"/g, '&quot;')}" class="logo" alt="">` : '';

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { margin: 0; }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif; color: #1f2933; margin: 0; padding: 44px 48px; font-size: 12.5px; line-height: 1.45; }
    .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; padding-bottom: 22px; border-bottom: 3px solid #0078c8; }
    .org { max-width: 60%; }
    .logo { max-height: 64px; max-width: 240px; margin-bottom: 8px; display: block; }
    .org .name { font-size: 19px; font-weight: 700; color: #10304a; }
    .org .meta { color: #52606d; font-size: 11.5px; margin-top: 4px; }
    .docbox { text-align: right; }
    .docbox h1 { font-size: 26px; margin: 0; letter-spacing: 0.03em; color: #10304a; text-transform: uppercase; }
    .docbox .num { font-size: 14px; color: #52606d; margin-top: 2px; }
    .docbox .status { display: inline-block; margin-top: 8px; font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; padding: 3px 10px; border-radius: 20px; }
    .status.paid { background: #e7f5ec; color: #1f8a4c; }
    .status.due { background: #fdf3e0; color: #b06f00; }
    .status.draft { background: #eef1f4; color: #52606d; }
    .parties { display: flex; justify-content: space-between; gap: 24px; margin: 24px 0 6px; }
    .party .lbl { font-size: 10px; text-transform: uppercase; letter-spacing: 0.07em; color: #9aa5b1; margin-bottom: 4px; }
    .party .who { font-weight: 700; font-size: 14px; color: #10304a; }
    .party .meta { color: #52606d; font-size: 11.5px; margin-top: 3px; }
    .terms { text-align: right; }
    .terms div { margin-bottom: 2px; }
    .terms .k { color: #9aa5b1; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em; }
    table { width: 100%; border-collapse: collapse; margin-top: 18px; }
    th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: #fff; background: #10304a; padding: 9px 10px; }
    th.n, td.n { text-align: right; white-space: nowrap; }
    td { padding: 9px 10px; border-bottom: 1px solid #e9edf1; vertical-align: top; }
    .desc { font-weight: 500; }
    .sub { color: #9aa5b1; font-size: 10.5px; margin-top: 2px; }
    .acct { color: #52606d; font-size: 11px; }
    tbody tr:nth-child(even) td { background: #fafbfc; }
    .totals { margin-top: 16px; margin-left: auto; width: 300px; }
    .totals div { display: flex; justify-content: space-between; padding: 5px 12px; font-size: 12.5px; }
    .totals .sep { border-top: 1px solid #e4e7eb; }
    .totals .grand { font-weight: 700; font-size: 15px; background: #f3f6f9; border-radius: 6px; padding: 9px 12px; margin-top: 4px; color: #10304a; }
    .totals .due { font-weight: 700; font-size: 14px; color: #b06f00; }
    .foot { margin-top: 40px; border-top: 1px solid #e4e7eb; padding-top: 12px; color: #6b7782; font-size: 10.5px; }
    .foot .note { color: #1f2933; font-size: 11.5px; margin-bottom: 8px; white-space: pre-wrap; }
  </style></head><body>
    <div class="top">
      <div class="org">
        ${logo}
        <div class="name">${orgName}</div>
        <div class="meta">${orgAddr}</div>
        ${orgContact ? `<div class="meta">${orgContact}</div>` : ''}
        ${org?.tax_number ? `<div class="meta">Tax no. ${esc(org.tax_number)}</div>` : ''}
      </div>
      <div class="docbox">
        <h1>${esc(label)}</h1>
        <div class="num">${esc(number)}</div>
        ${statusBadge(doc, paid)}
      </div>
    </div>

    <div class="parties">
      <div class="party">
        <div class="lbl">${recipientLabel}</div>
        <div class="who">${esc(doc.contact_name ?? '')}</div>
        ${recipientAddr ? `<div class="meta">${recipientAddr}</div>` : ''}
        ${recipientContact ? `<div class="meta">${recipientContact}</div>` : ''}
        ${doc.contact_tax_number ? `<div class="meta">Tax no. ${esc(doc.contact_tax_number)}</div>` : ''}
      </div>
      <div class="terms">
        <div><span class="k">Date</span></div><div>${esc(doc.date ?? '')}</div>
        ${doc.due_date ? `<div style="margin-top:6px"><span class="k">Due</span></div><div>${esc(doc.due_date)}</div>` : ''}
        ${doc.reference ? `<div style="margin-top:6px"><span class="k">Reference</span></div><div>${esc(doc.reference)}</div>` : ''}
        ${cur !== 'USD' ? `<div style="margin-top:6px"><span class="k">Currency</span></div><div>${esc(cur)}</div>` : ''}
      </div>
    </div>

    <table>
      <thead><tr>
        <th>Description</th><th>Account</th><th class="n">Qty</th><th class="n">Unit price</th>${hasTax ? '<th class="n">Tax</th>' : ''}<th class="n">Amount</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>

    <div class="totals">
      <div><span>Subtotal</span><span>${m(doc.subtotal)}</span></div>
      ${(doc.total_tax ?? 0) !== 0 ? `<div><span>Tax</span><span>${m(doc.total_tax)}</span></div>` : ''}
      <div class="grand"><span>Total ${esc(cur)}</span><span>${m(doc.total)}</span></div>
      ${paid > 0 ? `<div class="sep"><span>Paid / credited</span><span>−${m(paid)}</span></div>` : ''}
      ${doc.amount_due != null && doc.status !== 'DRAFT' ? `<div class="due"><span>Amount due</span><span>${m(doc.amount_due)}</span></div>` : ''}
    </div>

    <div class="foot">
      ${org?.invoice_footer ? `<div class="note">${esc(org.invoice_footer)}</div>` : ''}
      ${orgName}${org?.tax_number ? ' · Tax no. ' + esc(org.tax_number) : ''} — generated ${new Date().toLocaleDateString()}
    </div>
  </body></html>`;
}

function statusBadge(doc: any, paid: number): string {
  if (doc.status === 'DRAFT' || doc.status === 'SUBMITTED') return '<div class="status draft">Draft</div>';
  if (doc.amount_due != null && doc.amount_due <= 0 && doc.total > 0) return '<div class="status paid">Paid</div>';
  if (doc.amount_due != null && doc.amount_due > 0) return '<div class="status due">Amount due</div>';
  void paid; return '';
}

function esc(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Compose an email for a document and hand it to the user's email app. The
 * browser can't send mail itself, so: on devices that support sharing files we
 * offer "Share with PDF" (which attaches the PDF directly); everywhere else we
 * open the user's email client pre-filled via mailto: and download the PDF so
 * they can attach it. The subject/body come from the editable template.
 */
function EmailDialog({ kind, docId, pdfHtml, onClose }: { kind: DocKind; docId: number; pdfHtml: string; onClose: () => void }) {
  const toast = useToast();
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [filename, setFilename] = useState('document.pdf');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const canShareFiles = typeof navigator !== 'undefined' && !!(navigator as any).canShare;

  React.useEffect(() => {
    api('email.compose', kind, docId).then((c: any) => {
      setTo(c.to ?? ''); setSubject(c.subject ?? ''); setBody(c.body ?? '');
      setFilename(c.filename ?? 'document.pdf');
      setLoading(false);
    }).catch((e) => { setErr(e.message); setLoading(false); });
  }, [kind, docId]);

  function openMailClient() {
    const href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    // Download the PDF first so it's ready to attach, then open the mail client.
    exportPdf(pdfHtml, filename).then((r) => {
      if (!r.ok && r.error && r.error !== 'cancelled') { setErr(r.error); return; }
      try { window.location.href = href; } catch { /* ignore */ }
      toast('Opened your email — attach the downloaded PDF and send');
    });
  }

  async function shareWithPdf() {
    try {
      // Render the PDF to a Blob via the same export path, then share it.
      const blob = await (exportPdf as any)(pdfHtml, filename, { asBlob: true });
      const file = blob instanceof Blob ? new File([blob], filename, { type: 'application/pdf' }) : null;
      const data: any = { title: subject, text: body };
      if (file && (navigator as any).canShare?.({ files: [file] })) data.files = [file];
      await (navigator as any).share(data);
    } catch (e: any) {
      if (e?.name !== 'AbortError') openMailClient();
    }
  }

  return (
    <Modal title="Email document" onClose={onClose}>
      <ErrorBanner msg={err} />
      {loading ? <div className="muted">Preparing…</div> : (
        <>
          <Field label="To"><EmailField value={to} onChange={setTo} placeholder="recipient@example.com" /></Field>
          {!to && <p className="field-error">This contact has no email address — add one on the contact, or type it above.</p>}
          <Field label="Subject"><input value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>
          <Field label="Message"><textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
          <div className="info-bar">
            The app can’t send email on its own from your browser. It’ll open your email program with this message ready, and download the {filename} so you can attach it.
            {canShareFiles ? ' On this device you can also “Share with PDF”, which attaches it for you.' : ''}
          </div>
          <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
            <button className="btn" onClick={onClose}>Cancel</button>
            {canShareFiles && <button className="btn" disabled={!!emailError(to)} onClick={shareWithPdf}>Share with PDF</button>}
            <button className="btn primary" disabled={!!emailError(to)} onClick={openMailClient}>Open in email app</button>
          </div>
        </>
      )}
    </Modal>
  );
}

function ProgressInvoiceModal({ quoteId, onClose, onDone }: { quoteId: number; onClose: () => void; onDone: () => void }) {
  const { data: prog, error, loading, reload } = useApi<any>('invoices.quoteProgress', quoteId);
  const [mode, setMode] = useState<'percent' | 'amount'>('percent');
  const [percent, setPercent] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayIso());
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function create() {
    if (dateError(date)) { toast('Enter a valid date'); return; }
    const payload: any = { quote_id: quoteId, date };
    if (due && !dateError(due)) payload.due_date = due;
    if (mode === 'percent') { if (!Number(percent)) { toast('Enter a percentage'); return; } payload.percent = Number(percent); }
    else { if (!Number(amount)) { toast('Enter an amount'); return; } payload.amount = toCents(amount); }
    setBusy(true);
    try {
      await api('invoices.invoiceQuoteProgress', payload);
      toast('Progress invoice created as a draft');
      onDone();
    } catch (e: any) { toast(e.message || 'Could not create the progress invoice'); reload(); }
    finally { setBusy(false); }
  }

  const pct = prog ? Math.min(100, Math.max(0, prog.invoiced_pct)) : 0;

  return (
    <Modal title="Progress invoice" onClose={onClose} wide>
      {loading && prog == null ? <Spinner /> : error ? <ErrorBanner msg={error} /> : (
        <>
          <div className="muted small">Quote {prog.quote_number || ''} — total {money(prog.total)}.</div>
          <div style={{ margin: '10px 0' }}>
            <div style={{ height: 10, background: 'var(--line, #e5e7eb)', borderRadius: 6, overflow: 'hidden' }}>
              <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent, #2563eb)' }} />
            </div>
            <div className="muted small" style={{ marginTop: 4 }}>Invoiced {money(prog.invoiced)} ({prog.invoiced_pct}%) · Remaining {money(prog.remaining)}</div>
          </div>

          {prog.invoices.length > 0 && (
            <table className="tbl tight" style={{ marginBottom: 10 }}>
              <thead><tr><th>Date</th><th>Invoice</th><th>Status</th><th className="num">%</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {prog.invoices.map((i: any) => (
                  <tr key={i.id}><td>{fmtDate(i.date)}</td><td>{i.invoice_number || 'Draft'}</td><td>{i.status[0] + i.status.slice(1).toLowerCase()}</td><td className="num">{i.progress_pct != null ? `${i.progress_pct}%` : '—'}</td><td className="num">{money(i.total)}</td></tr>
                ))}
              </tbody>
            </table>
          )}

          {prog.remaining <= 0 ? (
            <div className="muted">This quote is fully invoiced.</div>
          ) : (
            <>
              <Field label="Invoice by">
                <select value={mode} onChange={(e) => setMode(e.target.value as any)} style={{ width: 200 }}>
                  <option value="percent">Percentage of quote</option>
                  <option value="amount">A specific amount</option>
                </select>
              </Field>
              {mode === 'percent'
                ? <Field label="Percentage"><input inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)} placeholder={`e.g. ${prog.remaining_pct}`} style={{ width: 120 }} /> </Field>
                : <Field label="Amount"><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" style={{ width: 140, textAlign: 'right' }} /></Field>}
              <div className="form-grid two">
                <Field label="Invoice date"><DateField value={date} onChange={setDate} /></Field>
                <Field label="Due date (optional)"><DateField value={due} onChange={setDue} /></Field>
              </div>
              <div className="muted small">Creates a draft invoice for that portion, linked to this quote. You can review and send it like any invoice.</div>
            </>
          )}

          <div className="modal-actions">
            <button className="btn" onClick={onClose} disabled={busy}>Close</button>
            {prog.remaining > 0 && <button className="btn primary" onClick={create} disabled={busy}>Create progress invoice</button>}
          </div>
        </>
      )}
    </Modal>
  );
}

// ── Approval panel (shown on invoices/bills that require sign-off) ───────────
function ApprovalPanel({ docId, state, onChanged }: { docId: number; state: any; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const ap = state?.approval;
  const label = state?.doc_type === 'ACCPAY' ? 'bill' : 'invoice';

  async function run(fn: () => Promise<any>, msg: string) {
    setBusy(true);
    try { await fn(); toast(msg); onChanged(); } catch (e: any) { toast(e.message); } finally { setBusy(false); }
  }

  const pending = ap && ap.status === 'PENDING' && state.doc_status === 'SUBMITTED';
  const approved = ap && ap.status === 'APPROVED';
  const rejected = ap && ap.status === 'REJECTED';

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3 style={{ marginTop: 0 }}>Approval</h3>
      {approved ? (
        <p className="muted small">Approved{ap.decided_at ? ` on ${fmtDate(ap.decided_at)}` : ''}{ap.note ? ` — “${ap.note}”` : ''}.</p>
      ) : pending ? (
        <>
          <p className="muted small">Awaiting approval{ap.requested_at ? ` (submitted ${fmtDate(ap.requested_at)})` : ''}. This {label} can’t be posted until it’s approved.</p>
          {!rejecting ? (
            <div className="btn-row">
              <button className="btn primary" disabled={busy} onClick={() => run(() => api('approvals.approve', docId), 'Approved and posted')}>Approve</button>
              <button className="btn danger" disabled={busy} onClick={() => setRejecting(true)}>Reject</button>
            </div>
          ) : (
            <div className="btn-row" style={{ alignItems: 'flex-end' }}>
              <Field label="Reason (optional)"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="why it’s going back" autoFocus /></Field>
              <button className="btn danger" disabled={busy} onClick={() => run(() => api('approvals.reject', docId, note || undefined), 'Sent back to draft')}>Confirm reject</button>
              <button className="btn" disabled={busy} onClick={() => setRejecting(false)}>Cancel</button>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="muted small">{rejected ? `Previously rejected${ap.note ? ` — “${ap.note}”` : ''}. ` : ''}This {label} needs approval before it can be posted.</p>
          <button className="btn primary" disabled={busy} onClick={() => run(() => api('approvals.submit', docId), 'Submitted for approval')}>Submit for approval</button>
        </>
      )}
    </div>
  );
}
