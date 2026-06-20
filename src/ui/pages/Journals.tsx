import React, { useMemo, useState } from 'react';
import { ImportModal } from '../ImportModal';
import { useApi, useToast, Money, Badge, Empty, Modal, Field, PickAccount, ErrorBanner, useTrackingCategories, TrackingSelects, ConfirmDanger, openSource , usePager, Pager, SearchSelect } from '../components';
import { DateField } from '../components';
import { Attachments } from '../Attachments';
import { api, money, toCents, fromCents, fmtDate, todayIso } from '../api';

export default function Journals() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [acctId, setAcctId] = useState<number | ''>('');
  const [minAmt, setMinAmt] = useState('');
  const [maxAmt, setMaxAmt] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const query = useMemo(() => ({
    search: search || undefined,
    status: status || undefined,
    from: from || undefined,
    to: to || undefined,
    account_id: acctId === '' ? undefined : acctId,
    min: minAmt !== '' ? Math.round(parseFloat(minAmt) * 100) : undefined,
    max: maxAmt !== '' ? Math.round(parseFloat(maxAmt) * 100) : undefined,
  }), [search, status, from, to, acctId, minAmt, maxAmt]);
  const { data, error, reload } = useApi<any[]>('journals.list', query);
  const { data: accounts } = useApi<any[]>('accounts.list', {});
  const pager = usePager(data, [query]);
  const toast = useToast();
  const [importing, setImporting] = useState(false);
  const anyFilter = !!(from || to || acctId !== '' || minAmt || maxAmt || status);
  const [editing, setEditing] = useState<any | null>(null);
  const [confirming, setConfirming] = useState<{ kind: 'void' | 'delete'; j: any } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const act = (fn: () => Promise<any>, msg: string) => async () => {
    setErr(null);
    try { await fn(); toast(msg); reload(); } catch (e: any) { setErr(e.message); }
  };

  return (
    <>
      <div className="page-head">
        <h1>Manual journals</h1>
        <div className="grow" />
        <button className="btn" onClick={() => setImporting(true)}>Import CSV</button>
        <button className="btn primary" onClick={() => setEditing({})}>+ New journal</button>
      </div>
      <ErrorBanner msg={error ?? err} />
      <div className="report-toolbar" style={{ marginBottom: 10 }}>
        <input className="searchbox" placeholder="Search narration, journal #, line description…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ minWidth: 280 }} />
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 140 }}>
          <option value="">All statuses</option>
          <option>DRAFT</option><option>POSTED</option><option>VOIDED</option>
        </select>
        <button className={`btn${anyFilter ? ' primary' : ''}`} onClick={() => setShowFilters((v) => !v)}>
          {showFilters ? 'Hide filters' : `Filters${anyFilter ? ' •' : ''}`}
        </button>
        {anyFilter && <button className="btn" onClick={() => { setFrom(''); setTo(''); setAcctId(''); setMinAmt(''); setMaxAmt(''); setStatus(''); }}>Clear</button>}
      </div>
      {showFilters && (
        <div className="card tight" style={{ marginBottom: 10 }}>
          <div className="filter-grid">
            <label className="filter-field">
              <span className="filter-label">From</span>
              <DateField value={from} onChange={setFrom} />
            </label>
            <label className="filter-field">
              <span className="filter-label">To</span>
              <DateField value={to} onChange={setTo} />
            </label>
            <label className="filter-field" style={{ minWidth: 240 }}>
              <span className="filter-label">Account</span>
              <SearchSelect value={acctId} onChange={(v) => setAcctId(v)} options={(accounts ?? []).map((a: any) => ({ id: a.id, label: `${a.code} ${a.name}` }))} placeholder="Any account" />
            </label>
            <label className="filter-field">
              <span className="filter-label">Amount from</span>
              <input type="number" placeholder="min" value={minAmt} onChange={(e) => setMinAmt(e.target.value)} style={{ width: 110 }} />
            </label>
            <label className="filter-field">
              <span className="filter-label">Amount to</span>
              <input type="number" placeholder="max" value={maxAmt} onChange={(e) => setMaxAmt(e.target.value)} style={{ width: 110 }} />
            </label>
          </div>
        </div>
      )}
      <div className="card tight">
        {data && data.length === 0 ? (
          <Empty title="No manual journals" sub="For accruals, corrections and adjustments that don't belong to a document." />
        ) : (
          <table className="tbl">
            <thead><tr><th>Date</th><th>Narration</th><th>Journal #</th><th>Status</th><th className="num">Amount</th><th /></tr></thead>
            <tbody>
              {pager.slice.map((j: any) => (
                <tr
                  key={j.id}
                  className="dbl"
                  title="Double-click to view this journal"
                  onDoubleClick={(e) => {
                    // Buttons in the row have their own jobs — a fast double
                    // tap on Edit/Copy shouldn't also pop the viewer.
                    if ((e.target as HTMLElement).closest('button')) return;
                    openSource('MANUAL', j.id);
                  }}
                >
                  <td>{fmtDate(j.date)}</td>
                  <td><strong>{j.narration}</strong>{j.auto_reversing_date && <div className="faint small">auto-reverses {fmtDate(j.auto_reversing_date)}</div>}</td>
                  <td className="mono small">{j.journal_number ?? '—'}</td>
                  <td><Badge status={j.status} /></td>
                  <td className="num"><Money cents={j.total_debit} /></td>
                  <td className="btn-row">
                    {j.status === 'DRAFT' && (
                      <>
                        <button className="btn small" onClick={() => setEditing(j)}>Edit</button>
                        <button className="btn small primary" onClick={act(() => api('journals.post', j.id), 'Journal posted')}>Post</button>
                        <button className="btn small danger" onClick={() => setConfirming({ kind: 'delete', j })}>Delete</button>
                      </>
                    )}
                    {j.status === 'POSTED' && (
                      <>
                        <button className="btn small" title="Reverses the posting and reopens it as a draft for editing" onClick={async () => {
                          setErr(null);
                          try { const back = await api('journals.revertToDraft', j.id); toast('Reopened as draft'); reload(); setEditing(back); } catch (e: any) { setErr(e.message); }
                        }}>Edit</button>
                        <button className="btn small danger" onClick={() => setConfirming({ kind: 'void', j })}>Void</button>
                      </>
                    )}
                    {j.status !== 'VOIDED' && (
                      <button className="btn small" title="New draft with the same lines, dated today" onClick={async () => {
                        setErr(null);
                        try {
                          const src = await api('journals.get', j.id);
                          setEditing({
                            __copy: true,
                            narration: src.narration,
                            date: '', // blank on purpose — a copy must be dated consciously
                            show_on_cash_basis: src.show_on_cash_basis,
                            lines: src.lines,
                          });
                        } catch (e: any) { setErr(e.message); }
                      }}>Copy</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data && data.length > 0 && <Pager pager={pager} noun="journals" />}
      </div>
      {editing && <JournalEditor journal={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
      {confirming?.kind === 'void' && (
        <ConfirmDanger
          title={`Void journal ${confirming.j.journal_number ?? ''}?`}
          lines={[
            `“${confirming.j.narration}” (${money(confirming.j.total_debit)}) will be marked VOIDED.`,
            'Its posting is reversed, so every report updates.',
            confirming.j.auto_reversing_date ? 'Its auto-reversal is reversed as well.' : 'The entry stays visible for your audit trail.',
            'This can’t be undone — to change the entry instead, use Edit.',
          ]}
          ack="I understand this reverses the posting and can’t be undone."
          confirmLabel="Void journal"
          onConfirm={async () => { await api('journals.voidJournal', confirming.j.id); toast('Journal voided'); reload(); }}
          onClose={() => setConfirming(null)}
        />
      )}
      {confirming?.kind === 'delete' && (
        <ConfirmDanger
          title="Delete this draft journal?"
          lines={[
            `“${confirming.j.narration}” has never posted to your ledger, so no figures change.`,
            'It will disappear from this list and can’t be recovered.',
          ]}
          confirmLabel="Delete draft"
          onConfirm={async () => { await api('journals.remove', confirming.j.id); toast('Draft deleted'); reload(); }}
          onClose={() => setConfirming(null)}
        />
      )}
      {importing && <ImportModal kinds={['JOURNAL']} onClose={() => setImporting(false)} onDone={() => reload()} />}
    </>
  );
}

interface JLine { account_id: number | ''; description: string; debit: string; credit: string; tracking_option_1: number | null; tracking_option_2: number | null }
const blank = (): JLine => ({ account_id: '', description: '', debit: '', credit: '', tracking_option_1: null, tracking_option_2: null });

function JournalEditor({ journal, onClose, onSaved }: { journal: any; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const trackingCats = useTrackingCategories();
  const isCopy = !!journal.__copy;
  const [narration, setNarration] = useState(journal.narration ?? '');
  const [date, setDate] = useState(isCopy ? '' : journal.date ?? todayIso());
  const [reversing, setReversing] = useState(isCopy ? '' : journal.auto_reversing_date ?? '');
  const [lines, setLines] = useState<JLine[]>(
    journal.id
      ? []
      : isCopy && journal.lines
        ? journal.lines.map((l: any) => ({
            account_id: l.account_id,
            description: l.description ?? '',
            debit: l.debit ? fromCents(l.debit) : '',
            credit: l.credit ? fromCents(l.credit) : '',
            tracking_option_1: l.tracking_option_1 ?? null,
            tracking_option_2: l.tracking_option_2 ?? null,
          }))
        : [blank(), blank()]
  );
  const [err, setErr] = useState<string | null>(null);
  // Leave-without-saving guard: a copy is dirty from the first moment.
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [snapshot, setSnapshot] = useState<string | null>(
    journal.id ? null : isCopy ? '"__copy__"' : JSON.stringify({ narration: '', date: todayIso(), reversing: '', lines: [blank(), blank()] })
  );
  const serialize = () => JSON.stringify({ narration, date, reversing, lines });
  const dirty = isCopy || (snapshot != null && serialize() !== snapshot);
  function guardedClose() {
    if (!dirty) return onClose();
    setConfirmLeave(true);
  }

  React.useEffect(() => {
    if (!journal.id) return;
    api('journals.get', journal.id).then((j: any) => {
      setLines(j.lines.map((l: any) => ({
        account_id: l.account_id,
        description: l.description ?? '',
        debit: l.debit ? fromCents(l.debit) : '',
        credit: l.credit ? fromCents(l.credit) : '',
        tracking_option_1: l.tracking_option_1 ?? null,
        tracking_option_2: l.tracking_option_2 ?? null,
      })));
      setSnapshot(JSON.stringify({ narration: j.narration ?? '', date: j.date ?? todayIso(), reversing: j.auto_reversing_date ?? '', lines: j.lines.map((l: any) => ({
        account_id: l.account_id,
        description: l.description ?? '',
        debit: l.debit ? fromCents(l.debit) : '',
        credit: l.credit ? fromCents(l.credit) : '',
        tracking_option_1: l.tracking_option_1 ?? null,
        tracking_option_2: l.tracking_option_2 ?? null,
      })) }));
    });
  }, [journal.id]);

  const setLine = (i: number, patch: Partial<JLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const totals = useMemo(() => {
    const dr = lines.reduce((s, l) => s + toCents(l.debit), 0);
    const cr = lines.reduce((s, l) => s + toCents(l.credit), 0);
    return { dr, cr, balanced: dr === cr && dr > 0 };
  }, [lines]);

  async function save(thenPost: boolean) {
    setErr(null);
    if (!date) return setErr('Pick a date — copies start with it blank on purpose');
    const body = lines.filter((l) => l.account_id).map((l) => ({
      account_id: l.account_id as number, description: l.description,
      debit: toCents(l.debit), credit: toCents(l.credit),
      tracking_option_1: l.tracking_option_1, tracking_option_2: l.tracking_option_2,
    }));
    if (body.length < 2) return setErr('A journal needs at least two lines');
    try {
      const id = await api('journals.saveDraft', { id: journal.id, narration, date, auto_reversing_date: reversing || null, lines: body });
      if (thenPost) await api('journals.post', id);
      toast(thenPost ? 'Journal posted' : 'Draft saved');
      onSaved();
    } catch (e: any) { setErr(e.message); }
  }

  return (
    <Modal title={journal.id ? 'Edit journal' : isCopy ? 'Copy of journal' : 'New manual journal'} wide onClose={guardedClose}>
      <ErrorBanner msg={err} />
      <div className="form-row">
        <Field label="Narration"><input value={narration} onChange={(e) => setNarration(e.target.value)} autoFocus /></Field>
        <Field label="Date"><DateField value={date} onChange={setDate} /></Field>
        <Field label="Auto-reversing date (optional)"><DateField value={reversing} onChange={setReversing} /></Field>
      </div>
      <table className="tbl">
        <thead><tr><th>Account</th><th>Description</th>{trackingCats.length > 0 && <th style={{ width: 150 }}>Tracking</th>}<th className="num" style={{ width: 130 }}>Debit</th><th className="num" style={{ width: 130 }}>Credit</th><th style={{ width: 30 }} /></tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td><PickAccount value={l.account_id} onChange={(id) => setLine(i, { account_id: id })} allowBank allowSystem /></td>
              <td><input value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} /></td>
              {trackingCats.length > 0 && (
                <td><div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <TrackingSelects categories={trackingCats} value1={l.tracking_option_1} value2={l.tracking_option_2}
                    onChange={(v1, v2) => setLine(i, { tracking_option_1: v1, tracking_option_2: v2 })} />
                </div></td>
              )}
              <td><input className="num" value={l.debit} onChange={(e) => setLine(i, { debit: e.target.value, credit: '' })} /></td>
              <td><input className="num" value={l.credit} onChange={(e) => setLine(i, { credit: e.target.value, debit: '' })} /></td>
              <td><a onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>✕</a></td>
            </tr>
          ))}
          <tr className="total">
            <td colSpan={trackingCats.length > 0 ? 3 : 2}>{totals.balanced ? <span className="badge green">balanced</span> : <span className="badge amber">out by {money(Math.abs(totals.dr - totals.cr))}</span>}</td>
            <td className="num">{money(totals.dr)}</td>
            <td className="num">{money(totals.cr)}</td>
            <td />
          </tr>
        </tbody>
      </table>
      <div style={{ marginTop: 10 }}>
        <button className="btn small" onClick={() => setLines((ls) => [...ls, blank()])}>+ Add line</button>
      </div>
      {journal.id && <Attachments entityType="manual_journal" entityId={journal.id} />}
      <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
        <button className="btn" onClick={guardedClose}>Cancel</button>
        <button className="btn" onClick={() => save(false)}>Save draft</button>
        <button className="btn primary" disabled={!totals.balanced} onClick={() => save(true)}>Post</button>
      </div>

      {confirmLeave && (
        <Modal title="Leave without saving?" onClose={() => setConfirmLeave(false)}>
          <p>{isCopy
            ? 'This copied journal hasn\u2019t been saved anywhere yet \u2014 leave now and it never existed.'
            : 'You\u2019ve made changes that aren\u2019t saved.'}</p>
          <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
            <button type="button" className="btn" onClick={() => setConfirmLeave(false)}>Keep editing</button>
            <button type="button" className="btn danger" onClick={() => { setConfirmLeave(false); onClose(); }}>Discard</button>
            <button type="button" className="btn primary" onClick={async () => { setConfirmLeave(false); await save(false); }}>Save as draft</button>
          </div>
        </Modal>
      )}
    </Modal>
  );
}
