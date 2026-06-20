/** Find & Recode — Xero-style bulk re-coding.
 *  Build conditions → search lines → tick the ones to change → recode
 *  contact / account / tax / tracking, with per-document skip reasons. */
import React, { useMemo, useState } from 'react';
import { api, money, fmtDate } from '../api';
import {
  useApi, useToast, Badge, Empty, Modal, Field, ErrorBanner, Spinner,
  MultiPick, SearchSelect, useTrackingCategories, openSource, usePager, Pager,
} from '../components';
import { DateField } from '../components';

type Row = any;

const TYPE_OPTS = [
  { id: 'ACCREC', label: 'Invoice' }, { id: 'ACCPAY', label: 'Bill' },
  { id: 'ACCRECCREDIT', label: 'Credit note' }, { id: 'ACCPAYCREDIT', label: 'Supplier credit' },
  { id: 'SPEND', label: 'Spend money' }, { id: 'RECEIVE', label: 'Receive money' },
  { id: 'MANUAL', label: 'Manual journal' },
];
const STATUS_OPTS = ['DRAFT', 'SUBMITTED', 'AUTHORISED', 'PAID', 'POSTED'].map((s) => ({ id: s, label: s.toLowerCase() }));

const FIELDS: Array<{ id: string; label: string }> = [
  { id: 'account', label: 'Account' },
  { id: 'contact', label: 'Contact' },
  { id: 'type', label: 'Type' },
  { id: 'status', label: 'Status' },
  { id: 'date', label: 'Date' },
  { id: 'tax', label: 'Tax rate' },
  { id: 'tracking', label: 'Tracking' },
  { id: 'amount', label: 'Line amount' },
  { id: 'text', label: 'Number / reference / description' },
  { id: 'bank_account', label: 'Bank account' },
];

let nextId = 1;
function blankCond() {
  return { id: nextId++, field: 'account', op: 'in', values: [] as any[], from: '', to: '', min: '', max: '', value: '' };
}

export default function FindRecode() {
  const toast = useToast();
  const { data: accounts } = useApi<any[]>('accounts.list', {});
  const { data: contactsList } = useApi<any[]>('contacts.list', {});
  const { data: taxRates } = useApi<any[]>('settings.listTaxRates');
  const trackingCats = useTrackingCategories();
  const { data: hist, reload: reloadHist } = useApi<any[]>('recode.history');

  const [match, setMatch] = useState<'all' | 'any'>('all');
  const [conds, setConds] = useState([blankCond()]);
  const [results, setResults] = useState<any | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [recoding, setRecoding] = useState(false);
  const [outcome, setOutcome] = useState<any | null>(null);

  const accountOpts = useMemo(() => (accounts ?? []).map((a) => ({ id: a.id, label: `${a.code} ${a.name}` })), [accounts]);
  const bankOpts = useMemo(() => (accounts ?? []).filter((a) => a.is_bank_account).map((a) => ({ id: a.id, label: `${a.code} ${a.name}` })), [accounts]);
  const contactOpts = useMemo(() => (contactsList ?? []).map((c) => ({ id: c.id, label: c.name })), [contactsList]);
  const taxOpts = useMemo(() => (taxRates ?? []).map((t) => ({ id: t.id, label: t.name })), [taxRates]);
  const trackingOpts = useMemo(
    () => trackingCats.flatMap((c: any) => c.options.map((o: any) => ({ id: o.id, label: `${c.name}: ${o.name}` }))),
    [trackingCats]
  );

  const key = (l: Row) => `${l.source}:${l.line_id}`;

  function setCond(id: number, patch: any) {
    setConds((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  function buildCriteria() {
    const out: any[] = [];
    for (const c of conds) {
      switch (c.field) {
        case 'account': case 'contact':
          if (c.values.length) out.push({ field: c.field, op: c.op, values: c.values });
          break;
        case 'type': case 'status': case 'tax': case 'tracking': case 'bank_account':
          if (c.values.length) out.push({ field: c.field, values: c.values });
          break;
        case 'date':
          if (c.from || c.to) out.push({ field: 'date', from: c.from || undefined, to: c.to || undefined });
          break;
        case 'amount': {
          const min = c.min !== '' ? Math.round(parseFloat(c.min) * 100) : undefined;
          const max = c.max !== '' ? Math.round(parseFloat(c.max) * 100) : undefined;
          if (min != null || max != null) out.push({ field: 'amount', min, max });
          break;
        }
        case 'text':
          if (c.value.trim()) out.push({ field: 'text', value: c.value.trim() });
          break;
      }
    }
    return { match, conds: out };
  }

  async function runSearch() {
    setErr(null);
    setOutcome(null);
    const criteria = buildCriteria();
    if (!criteria.conds.length) { setErr('Give at least one condition a value before searching'); return; }
    setBusy(true);
    try {
      const r = await api('recode.search', criteria);
      setResults(r);
      setSelected(new Set(r.lines.map(key))); // everything found starts selected — untick to exclude
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  const lines: Row[] = results?.lines ?? [];
  const pager = usePager(lines, [results]);
  const selLines = lines.filter((l) => selected.has(key(l)));
  const selDocs = new Set(selLines.map((l) => `${l.source}:${l.doc_id}`)).size;
  const allShownSelected = lines.length > 0 && selLines.length === lines.length;

  function ValueControl({ c }: { c: any }) {
    switch (c.field) {
      case 'account': return <MultiPick label="Accounts" options={accountOpts} value={c.values} onChange={(v) => setCond(c.id, { values: v })} />;
      case 'contact': return <MultiPick label="Contacts" options={contactOpts} value={c.values} onChange={(v) => setCond(c.id, { values: v })} />;
      case 'type': return <MultiPick label="Types" options={TYPE_OPTS} value={c.values} onChange={(v) => setCond(c.id, { values: v })} />;
      case 'status': return <MultiPick label="Statuses" options={STATUS_OPTS} value={c.values} onChange={(v) => setCond(c.id, { values: v })} />;
      case 'tax': return <MultiPick label="Tax rates" options={taxOpts} value={c.values} onChange={(v) => setCond(c.id, { values: v })} />;
      case 'tracking': return <MultiPick label="Tracking" options={trackingOpts} value={c.values} onChange={(v) => setCond(c.id, { values: v })} />;
      case 'bank_account': return <MultiPick label="Bank accounts" options={bankOpts} value={c.values} onChange={(v) => setCond(c.id, { values: v })} />;
      case 'date': return (
        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          <DateField value={c.from} onChange={(v) => setCond(c.id, { from: v })} style={{ width: 150 }} label="from date" />
          <span className="muted">to</span>
          <DateField value={c.to} onChange={(v) => setCond(c.id, { to: v })} style={{ width: 150 }} label="to date" />
        </span>
      );
      case 'amount': return (
        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          <input type="number" placeholder="min" value={c.min} onChange={(e) => setCond(c.id, { min: e.target.value })} style={{ width: 110 }} />
          <span className="muted">to</span>
          <input type="number" placeholder="max" value={c.max} onChange={(e) => setCond(c.id, { max: e.target.value })} style={{ width: 110 }} />
        </span>
      );
      default: return <input placeholder="contains…" value={c.value} onChange={(e) => setCond(c.id, { value: e.target.value })} style={{ width: 280 }} />;
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>Find &amp; recode</h1>
      </div>
      <ErrorBanner msg={err} />

      <div className="card">
        <p style={{ margin: '0 0 12px' }}>
          Find transaction lines that match{' '}
          <select value={match} onChange={(e) => setMatch(e.target.value as any)} style={{ width: 76, display: 'inline-block' }}>
            <option value="all">All</option>
            <option value="any">Any</option>
          </select>{' '}
          of the following conditions:
        </p>
        {conds.map((c) => (
          <div key={c.id} className="report-toolbar" style={{ marginBottom: 8 }}>
            <select value={c.field} onChange={(e) => setCond(c.id, { field: e.target.value, values: [], from: '', to: '', min: '', max: '', value: '' })} style={{ width: 230 }}>
              {FIELDS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
            {(c.field === 'account' || c.field === 'contact') ? (
              <select value={c.op} onChange={(e) => setCond(c.id, { op: e.target.value })} style={{ width: 90 }}>
                <option value="in">Is</option>
                <option value="not_in">Is not</option>
              </select>
            ) : (
              <span className="muted" style={{ width: 90, textAlign: 'center' }}>{c.field === 'date' || c.field === 'amount' ? 'between' : c.field === 'text' ? 'contains' : 'is'}</span>
            )}
            <ValueControl c={c} />
            <div className="grow" />
            {conds.length > 1 && (
              <button className="btn" title="Remove this condition" onClick={() => setConds((cs) => cs.filter((x) => x.id !== c.id))}>✕</button>
            )}
          </div>
        ))}
        <div className="btn-row">
          <button className="btn" onClick={() => setConds((cs) => [...cs, blankCond()])}>+ Add a condition</button>
          <div className="grow" />
          <button className="btn primary" disabled={busy} onClick={runSearch}>Search</button>
        </div>
      </div>

      {busy && <Spinner />}

      {outcome && (
        <div className="card">
          <div className="ok-banner">
            Recoded <strong>{outcome.done}</strong> line{outcome.done === 1 ? '' : 's'}
            {outcome.skipped ? ` · ${outcome.skipped} skipped (reasons below)` : ''} — run #{outcome.run_id} saved to history with before &amp; after.
          </div>
          {outcome.results.filter((r: any) => r.status === 'SKIPPED').length > 0 && (
            <table className="tbl" style={{ marginTop: 10 }}>
              <thead><tr><th>Document</th><th>Lines</th><th>Why it was skipped</th></tr></thead>
              <tbody>
                {outcome.results.filter((r: any) => r.status === 'SKIPPED').map((r: any, i: number) => (
                  <tr key={i}><td>{r.label}</td><td>{r.lines}</td><td className="small" style={{ color: 'var(--red)' }}>{r.reason}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {results && (
        <div className="card">
          {lines.length === 0 ? (
            <Empty title="No lines match" sub="Loosen a condition and search again." />
          ) : (
            <>
              <p className="muted small" style={{ marginTop: 0 }}>
                Found <strong>{results.total}</strong> line{results.total === 1 ? '' : 's'} across <strong>{results.transactions}</strong> transaction{results.transactions === 1 ? '' : 's'}
                {results.truncated ? ' (showing the first 5000 — refine the conditions to see the rest)' : ''}.
                Untick anything that shouldn't change.
              </p>
              <table className="tbl">
                <thead><tr>
                  <th style={{ width: 30 }}>
                    <input
                      type="checkbox" checked={allShownSelected} title="Select or unselect everything shown"
                      onChange={(e) => setSelected(e.target.checked ? new Set(lines.map(key)) : new Set())}
                    />
                  </th>
                  <th>Date</th><th>Type</th><th>Number / ref</th><th>Contact</th><th>Description</th>
                  <th>Account</th><th>Tax</th><th>Tracking</th><th className="num">Amount</th><th>Status</th>
                </tr></thead>
                <tbody>
                  {pager.slice.map((l: any) => (
                    <tr key={key(l)} className="dbl" title="Double-click to open the transaction"
                      onDoubleClick={() => openSource(l.source, l.doc_id)}>
                      <td>
                        <input type="checkbox" checked={selected.has(key(l))}
                          onChange={(e) => setSelected((s) => { const n = new Set(s); e.target.checked ? n.add(key(l)) : n.delete(key(l)); return n; })} />
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(l.date)}</td>
                      <td><Badge status={l.type} label={l.type_label} /></td>
                      <td className="mono small">{l.number ?? l.reference ?? ''}</td>
                      <td className="small">{l.contact_name ?? ''}</td>
                      <td className="small">{l.description ?? ''}</td>
                      <td className="small">{l.account_code} {l.account_name}</td>
                      <td className="small">{l.tax_name ?? ''}</td>
                      <td className="small">{[l.tracking_1, l.tracking_2].filter(Boolean).join(' · ')}</td>
                      <td className="num">{money(l.amount)}{l.currency_code && l.currency_code !== 'USD' ? ` ${l.currency_code}` : ''}</td>
                      <td><Badge status={l.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pager pager={pager} noun="lines" />
              <div className="btn-row" style={{ marginTop: 12 }}>
                <span className="muted small">{selLines.length} line{selLines.length === 1 ? '' : 's'} in {selDocs} transaction{selDocs === 1 ? '' : 's'} selected</span>
                <div className="grow" />
                <button className="btn primary" disabled={selLines.length === 0} onClick={() => setRecoding(true)}>Recode selected…</button>
              </div>
            </>
          )}
        </div>
      )}

      {(hist ?? []).length > 0 && (
        <div className="card">
          <h2>Recode history</h2>
          <table className="tbl">
            <thead><tr><th>When</th><th>By</th><th>Changes</th><th className="num">Done</th><th className="num">Skipped</th></tr></thead>
            <tbody>
              {(hist ?? []).map((r: any) => (
                <tr key={r.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{r.run_at}</td>
                  <td>{r.user_name ?? '—'}</td>
                  <td className="mono small">{summariseChanges(r.changes_json, accountOpts, taxOpts, trackingOpts, contactOpts)}</td>
                  <td className="num">{r.items_done}</td>
                  <td className="num">{r.items_skipped}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">Every changed line's before &amp; after coding is stored with its run.</p>
        </div>
      )}

      {recoding && (
        <RecodeModal
          count={selLines.length}
          docs={selDocs}
          accountOpts={accountOpts}
          contactOpts={contactOpts}
          taxOpts={taxOpts}
          trackingCats={trackingCats}
          onClose={() => setRecoding(false)}
          onRun={async (changes: any) => {
            setRecoding(false);
            setBusy(true);
            try {
              const r = await api('recode.recode', {
                targets: selLines.map((l) => ({ source: l.source, doc_id: l.doc_id, line_id: l.line_id })),
                changes,
                criteria: buildCriteria(),
              });
              setOutcome(r);
              toast(`Recoded ${r.done} line${r.done === 1 ? '' : 's'}`);
              reloadHist();
              await runSearch(); // refresh with the new coding
            } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
          }}
        />
      )}
    </>
  );
}

function summariseChanges(json: string, accounts: any[], taxes: any[], tracking: any[], contactsOpts: any[]) {
  try {
    const ch = JSON.parse(json ?? '{}') ?? {};
    const name = (opts: any[], id: any) => opts.find((o) => o.id === id)?.label ?? `#${id}`;
    const bits: string[] = [];
    if (ch.contact_id !== undefined) bits.push(`contact → ${name(contactsOpts, ch.contact_id)}`);
    if (ch.account_id !== undefined) bits.push(`account → ${name(accounts, ch.account_id)}`);
    if (ch.tax_rate_id !== undefined) bits.push(`tax → ${name(taxes, ch.tax_rate_id)}`);
    if (ch.tracking_option_1 !== undefined) bits.push(ch.tracking_option_1 === null ? 'tracking 1 cleared' : `tracking → ${name(tracking, ch.tracking_option_1)}`);
    if (ch.tracking_option_2 !== undefined) bits.push(ch.tracking_option_2 === null ? 'tracking 2 cleared' : `tracking → ${name(tracking, ch.tracking_option_2)}`);
    return bits.join(' · ') || '—';
  } catch { return '—'; }
}

function RecodeModal({ count, docs, accountOpts, contactOpts, taxOpts, trackingCats, onClose, onRun }: any) {
  const KEEP = '__keep__';
  const CLEAR = '__clear__';
  const [contact, setContact] = useState<number | ''>('');
  const [account, setAccount] = useState<number | ''>('');
  const [tax, setTax] = useState<string>(KEEP);
  const [t1, setT1] = useState<string>(KEEP);
  const [t2, setT2] = useState<string>(KEEP);
  const [confirming, setConfirming] = useState(false);

  const changes: any = {};
  if (contact !== '') changes.contact_id = contact;
  if (account !== '') changes.account_id = account;
  if (tax !== KEEP) changes.tax_rate_id = Number(tax);
  if (t1 !== KEEP) changes.tracking_option_1 = t1 === CLEAR ? null : Number(t1);
  if (trackingCats.length > 1 && t2 !== KEEP) changes.tracking_option_2 = t2 === CLEAR ? null : Number(t2);
  const anything = Object.keys(changes).length > 0;

  return (
    <Modal title="Recode transactions" onClose={onClose}>
      <p>
        Recode these <strong>{count}</strong> line item{count === 1 ? '' : 's'} affecting <strong>{docs}</strong> transaction{docs === 1 ? '' : 's'} using the selected changes — anything left on "Don't change" stays exactly as it is.
      </p>
      <Field label="Contact">
        <SearchSelect value={contact} onChange={(v) => setContact(v)} options={contactOpts} placeholder="Don't change" />
      </Field>
      <Field label="Account">
        <SearchSelect value={account} onChange={(v) => setAccount(v)} options={accountOpts} placeholder="Don't recode" />
      </Field>
      <Field label="Tax rate">
        <select value={tax} onChange={(e) => setTax(e.target.value)}>
          <option value={KEEP}>Don't recode</option>
          {taxOpts.map((t: any) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      </Field>
      {trackingCats[0] && (
        <Field label={trackingCats[0].name}>
          <select value={t1} onChange={(e) => setT1(e.target.value)}>
            <option value={KEEP}>Don't recode</option>
            <option value={CLEAR}>Clear (remove the tag)</option>
            {trackingCats[0].options.map((o: any) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </Field>
      )}
      {trackingCats[1] && (
        <Field label={trackingCats[1].name}>
          <select value={t2} onChange={(e) => setT2(e.target.value)}>
            <option value={KEEP}>Don't recode</option>
            <option value={CLEAR}>Clear (remove the tag)</option>
            {trackingCats[1].options.map((o: any) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </Field>
      )}
      <p className="muted small">
        Amount-safe changes (contact, account, tracking) work even on paid documents — the ledger entry is rebuilt in place.
        Tax changes recompute the totals, so they only apply to documents with no payments or credits attached; anything else is skipped with its reason shown.
      </p>
      {!confirming ? (
        <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!anything} onClick={() => setConfirming(true)}>Review</button>
        </div>
      ) : (
        <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 14, alignItems: 'center' }}>
          <span className="muted small">This changes {count} line{count === 1 ? '' : 's'} — sure?</span>
          <button className="btn" onClick={() => setConfirming(false)}>Back</button>
          <button className="btn danger" onClick={() => onRun(changes)}>Recode {count} line{count === 1 ? '' : 's'}</button>
        </div>
      )}
    </Modal>
  );
}
