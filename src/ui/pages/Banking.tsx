import React, { useRef, useState } from 'react';
import { useApi, useToast, Money, Badge, Empty, Tabs, Modal, Field, PickContact, PickAccount, PickTaxRate, ErrorBanner, ConfirmDanger, useTrackingCategories, TrackingSelects , usePager, Pager, SearchSelect } from '../components';
import { DateField } from '../components';
import { api, fmtDate, money, todayIso, toCents, saveCsv } from '../api';
import { useHash, nav } from '../App';

export default function Banking({ route }: { route: string[] }) {
  const accountId = route[1] ? Number(route[1]) : null;
  if (accountId) return <BankDetail id={accountId} />;
  return <BankList />;
}

function BankList() {
  const { data, error } = useApi<any[]>('banking.accounts');
  return (
    <>
      <div className="page-head"><h1>Bank accounts</h1></div>
      <ErrorBanner msg={error} />
      <div className="grid cols-2">
        {(data ?? []).map((b) => (
          <div key={b.id} className="card" style={{ cursor: 'pointer' }} onClick={() => nav(`bank/${b.id}`)}>
            <div className="card-head">
              <h2 style={{ margin: 0 }}>{b.name}</h2>
              <div className="grow" />
              {b.unreconciled > 0 ? <span className="badge amber">{b.unreconciled} to reconcile</span> : <span className="badge green">reconciled</span>}
            </div>
            <div className="stat">
              <div className="label">Balance in Book of Business</div>
              <div className="value">{money(b.ledger_balance)}</div>
              <div className="sub">{b.last_statement_date ? `Last statement ${b.last_statement_date}` : "No statements imported yet"}</div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function BankDetail({ id }: { id: number }) {
  const [tab, setTab] = useState('reconcile');
  const { data: accounts } = useApi<any[]>('banking.accounts');
  const acct = (accounts ?? []).find((a) => a.id === id);
  return (
    <>
      <div className="page-head">
        <a onClick={() => nav('bank')}>← Bank accounts</a>
        <h1>{acct?.name ?? 'Bank account'}</h1>
        <div className="grow" />
        <span className="muted">Balance {money(acct?.ledger_balance ?? 0)}</span>
      </div>
      <Tabs
        tabs={[
          { id: 'reconcile', label: 'Reconcile' },
          { id: 'transactions', label: 'Account transactions' },
          { id: 'import', label: 'Import statement' },
          { id: 'feeds', label: 'Bank feeds' },
          { id: 'rules', label: 'Bank rules' },
          { id: 'spend', label: 'Spend / receive money' },
          { id: 'transfer', label: 'Transfer money' },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'reconcile' && <Reconcile bankId={id} />}
      {tab === 'transactions' && <Transactions bankId={id} />}
      {tab === 'import' && <ImportStatement bankId={id} />}
      {tab === 'feeds' && <BankFeeds bankId={id} />}
      {tab === 'rules' && <BankRules />}
      {tab === 'spend' && <SpendReceive bankId={id} />}
      {tab === 'transfer' && <TransferMoney bankId={id} />}
    </>
  );
}

// ── Reconcile ────────────────────────────────────────────────────────────

function Reconcile({ bankId }: { bankId: number }) {
  const { data: lines, error, reload } = useApi<any[]>('banking.unreconciled', bankId);
  const { data: banks } = useApi<any[]>('banking.accounts');
  const toast = useToast();
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState<any | null>(null);
  const [transferring, setTransferring] = useState<any | null>(null);

  const act = (fn: () => Promise<any>, msg: string) => async () => {
    setErr(null);
    try { await fn(); toast(msg); reload(); } catch (e: any) { setErr(e.message); }
  };

  if (lines && lines.length === 0)
    return <div className="card"><Empty title="All reconciled 🎉" sub="Import a statement to keep matching bank activity to your ledger." /></div>;

  return (
    <>
      <ErrorBanner msg={error ?? err} />
      {(lines ?? []).map((l) => {
        const match = l.suggestion?.find((s: any) => s.kind === 'PAYMENT' || s.kind === 'BANKTXN');
        const openInv = l.suggestion?.find((s: any) => s.kind === 'INVOICE');
        return (
          <div key={l.id} className="card" style={{ display: 'flex', gap: 24, alignItems: 'center', padding: '16px 20px' }}>
            <div style={{ width: 330 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <strong>{l.payee ?? l.description ?? 'Statement line'}</strong>
                <strong style={{ color: l.amount >= 0 ? 'var(--green)' : 'var(--ink)' }}>{money(l.amount)}</strong>
              </div>
              <div className="small muted">{fmtDate(l.date)} {l.description && l.payee ? `· ${l.description}` : ''}{l.reference ? ` · ${l.reference}` : ''}</div>
            </div>
            <div style={{ flex: 1 }}>
              {match ? (
                <div className="small">
                  <span className="badge green">match found</span>{' '}
                  {match.kind === 'PAYMENT' ? 'Payment' : 'Bank transaction'} {match.reference ?? ''} {match.contact_name ?? ''} · {money(match.amount)}
                </div>
              ) : openInv ? (
                <div className="small"><span className="badge blue">open invoice</span> {openInv.invoice_number} {openInv.contact_name} · {money(openInv.amount_due)} due</div>
              ) : l.rule ? (
                <div className="small"><span className="badge blue">rule</span> {l.rule.name}</div>
              ) : (
                <span className="small faint">No suggestion — create a transaction or transfer.</span>
              )}
            </div>
            <div className="btn-row">
              {match && <button className="btn primary small" onClick={act(() => api('banking.reconcileMatch', l.id, match.kind, match.id), 'Matched')}>OK</button>}
              {!match && openInv && <button className="btn primary small" onClick={act(() => api('banking.reconcilePayInvoice', l.id, openInv.id), 'Payment created & matched')}>Pay {openInv.invoice_number}</button>}
              <button className="btn small" onClick={() => setCreating(l)}>Create</button>
              <button className="btn small" onClick={() => setTransferring(l)}>Transfer</button>
            </div>
          </div>
        );
      })}
      {creating && (
        <CreateFromLine line={creating} onClose={() => setCreating(null)} onDone={() => { setCreating(null); reload(); }} />
      )}
      {transferring && (
        <Modal title="Reconcile as transfer" onClose={() => setTransferring(null)}>
          <p className="muted">Move {money(Math.abs(transferring.amount))} {transferring.amount >= 0 ? 'into this account from' : 'out of this account into'}:</p>
          <div className="form-row">
            <select onChange={async (e) => {
              if (!e.target.value) return;
              try {
                await api('banking.reconcileTransfer', transferring.id, Number(e.target.value));
                toast('Transfer reconciled');
                setTransferring(null);
                reload();
              } catch (er: any) { setErr(er.message); setTransferring(null); }
            }}>
              <option value="">Choose account…</option>
              {(banks ?? []).filter((b) => b.id !== bankId).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
        </Modal>
      )}
    </>
  );
}

function CreateFromLine({ line, onClose, onDone }: { line: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [contact, setContact] = useState<number | ''>(line.rule?.set_contact_id ?? '');
  const [account, setAccount] = useState<number | ''>(line.rule?.set_account_id ?? '');
  const [taxRate, setTaxRate] = useState<number | null>(line.rule?.set_tax_rate_id ?? null);
  const [desc, setDesc] = useState(line.description ?? line.payee ?? '');
  const [t1, setT1] = useState<number | null>(null);
  const [t2, setT2] = useState<number | null>(null);
  const trackingCats = useTrackingCategories();
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setErr(null);
    if (!account) return setErr('Choose an account to code this to');
    try {
      await api('banking.reconcileCreate', line.id, { contact_id: contact || undefined, account_id: account, tax_rate_id: taxRate, description: desc, tracking_option_1: t1, tracking_option_2: t2 });
      toast(`${line.amount >= 0 ? 'Receive' : 'Spend'} money created & reconciled`);
      onDone();
    } catch (e: any) { setErr(e.message); }
  }

  return (
    <Modal title={`Create ${line.amount >= 0 ? 'receive' : 'spend'} money — ${money(Math.abs(line.amount))}`} onClose={onClose}>
      <ErrorBanner msg={err} />
      <div className="form-row">
        <Field label="Contact (optional)"><PickContact value={contact} onChange={setContact} /></Field>
        <Field label="Account"><PickAccount value={account} onChange={setAccount} /></Field>
      </div>
      <div className="form-row">
        <Field label="Tax rate"><PickTaxRate value={taxRate} onChange={setTaxRate} /></Field>
        <Field label="Description"><input value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
      </div>
      {trackingCats.length > 0 && (
        <div className="form-row">
          <Field label="Tracking">
            <div style={{ display: 'flex', gap: 8 }}>
              <TrackingSelects categories={trackingCats} value1={t1} value2={t2} onChange={(a, b) => { setT1(a); setT2(b); }} />
            </div>
          </Field>
        </div>
      )}
      <p className="small faint">Statement amounts are treated as tax inclusive.</p>
      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={submit}>Create & reconcile</button>
      </div>
    </Modal>
  );
}

// ── Transactions / Import / Rules / Spend ────────────────────────────────

function Transactions({ bankId }: { bankId: number }) {
  const { data, reload } = useApi<any[]>('banking.listTransactions', bankId);
  const toast = useToast();
  const [voiding, setVoiding] = useState<any | null>(null);
  const pager = usePager(data, [bankId]);
  return (
    <div className="card tight">
      {data && data.length === 0 ? <Empty title="No bank transactions yet" /> : (
        <table className="tbl">
          <thead><tr><th>Date</th><th>Type</th><th>Contact</th><th>Reference</th><th>Status</th><th className="num">Amount</th><th /></tr></thead>
          <tbody>
            {pager.slice.map((t: any) => (
              <tr key={t.id}>
                <td>{fmtDate(t.date)}</td>
                <td><Badge status={t.type} /></td>
                <td>{t.contact_name}</td>
                <td>{t.reference}</td>
                <td><Badge status={t.status} /></td>
                <td className="num"><Money cents={t.type === 'SPEND' ? -t.total : t.total} /></td>
                <td>{t.status === 'POSTED' && <a onClick={() => setVoiding(t)}>void</a>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data && data.length > 0 && <Pager pager={pager} noun="transactions" />}
      {voiding && (
        <ConfirmDanger
          title="Void this bank transaction?"
          lines={[
            `${voiding.type === 'RECEIVE' ? 'Receive' : 'Spend'} money of ${money(voiding.total)} on ${fmtDate(voiding.date)}${voiding.contact_name ? ` — ${voiding.contact_name}` : ''}.`,
            'Its ledger entry is reversed, so the bank balance and reports update.',
            'Any statement line it was matched to becomes unreconciled.',
            'This can’t be undone — you can re-enter the transaction afterwards.',
          ]}
          ack="I understand this reverses the entry and can’t be undone."
          confirmLabel="Void transaction"
          onConfirm={async () => { await api('banking.voidBankTransaction', voiding.id); toast('Voided'); reload(); }}
          onClose={() => setVoiding(null)}
        />
      )}
    </div>
  );
}

function ImportStatement({ bankId }: { bankId: number }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [preview, setPreview] = useState<any | null>(null);
  const [result, setResult] = useState<any | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onFile(f: File) {
    setErr(null); setResult(null); setPreview(null);
    try {
      const text = await f.text();
      setFile({ name: f.name, text });
      const p = await api('banking.previewStatement', f.name, text);
      setPreview(p);
    } catch (e: any) { setErr(e.message); setFile(null); }
  }

  async function confirmImport() {
    if (!file) return;
    setBusy(true); setErr(null);
    try {
      const r = await api('banking.importStatement', bankId, file.name, file.text);
      setResult(r);
      setPreview(null); setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      toast(`Imported ${r.imported} lines (${r.duplicates} duplicates skipped)`);
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function downloadTemplate(style: 'amount' | 'debitcredit') {
    const csv = await api(style === 'amount' ? 'banking.statementTemplate' : 'banking.statementTemplateDebitCredit');
    await saveCsv(csv, `bank-statement-template-${style === 'amount' ? 'amount' : 'debit-credit'}.csv`);
  }

  return (
    <div className="card">
      <ErrorBanner msg={err} />
      <h2>Import a bank statement</h2>
      <p className="muted">
        CSV or OFX/QFX exported from your bank. Works with a single <strong>Amount</strong> column or separate
        <strong> Debit/Credit</strong> columns, and common date layouts (the format is detected automatically).
        Duplicate lines are skipped, so re-importing the same file is safe.
      </p>
      <input ref={fileRef} type="file" accept=".csv,.ofx,.qfx,.txt" style={{ width: 'auto' }} onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
      <div className="btn-row" style={{ marginTop: 10 }}>
        <span className="muted small">Not sure of the format? Download a template:</span>
        <button className="btn small" onClick={() => downloadTemplate('amount')}>Template (Amount)</button>
        <button className="btn small" onClick={() => downloadTemplate('debitcredit')}>Template (Debit / Credit)</button>
      </div>

      {preview && (
        <div style={{ marginTop: 16 }}>
          <div className="ok-banner">
            Found <strong>{preview.total}</strong> transactions{preview.from ? <> from <strong>{fmtDate(preview.from)}</strong> to <strong>{fmtDate(preview.to)}</strong></> : ''} —
            money in <strong><Money cents={preview.money_in} /></strong>, money out <strong><Money cents={preview.money_out} /></strong>.
            Check the sample below, then import.
          </div>
          {preview.sample?.length > 0 && (
            <table className="tbl" style={{ marginTop: 10 }}>
              <thead><tr><th>Date</th><th>Payee / description</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {preview.sample.map((l: any, i: number) => (
                  <tr key={i}>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(l.date)}</td>
                    <td className="small">{[l.payee, l.description].filter(Boolean).join(' · ') || l.reference || ''}</td>
                    <td className="num" style={{ color: l.amount < 0 ? 'var(--red)' : 'var(--green)' }}><Money cents={l.amount} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {preview.total > preview.sample.length && <p className="muted small">…and {preview.total - preview.sample.length} more.</p>}
          <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
            <button className="btn" onClick={() => { setPreview(null); setFile(null); if (fileRef.current) fileRef.current.value = ''; }}>Cancel</button>
            <button className="btn primary" disabled={busy} onClick={confirmImport}>Import {preview.total} transactions</button>
          </div>
        </div>
      )}

      {result && (
        <div className="ok-banner" style={{ marginTop: 16 }}>
          Imported {result.imported} of {result.total} lines. {result.duplicates > 0 && `${result.duplicates} already existed.`} Head to the Reconcile tab to match them.
        </div>
      )}
    </div>
  );
}

function BankRules() {
  const { data, reload } = useApi<any[]>('banking.listRules');
  const toast = useToast();
  const [deletingRule, setDeletingRule] = useState<any | null>(null);
  return (
    <div className="card tight">
      {deletingRule && (
        <ConfirmDanger
          title={`Delete rule “${deletingRule.name}”?`}
          lines={[
            'The rule stops suggesting coding for new statement lines.',
            'Transactions it already coded are not affected.',
          ]}
          confirmLabel="Delete rule"
          onConfirm={async () => { await api('banking.deleteRule', deletingRule.id); toast('Rule deleted'); reload(); }}
          onClose={() => setDeletingRule(null)}
        />
      )}
      {data && data.length === 0 ? (
        <Empty title="No bank rules" sub="Rules auto-suggest coding for recurring statement lines (e.g. payee contains “power”)." />
      ) : (
        <table className="tbl">
          <thead><tr><th>Rule</th><th>Direction</th><th>Conditions</th><th /></tr></thead>
          <tbody>
            {(data ?? []).map((r) => (
              <tr key={r.id}>
                <td><strong>{r.name}</strong></td>
                <td><Badge status={r.direction ?? 'ANY'} /></td>
                <td className="mono small">{r.conditions_json}</td>
                <td><a onClick={() => setDeletingRule(r)}>delete</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SpendReceive({ bankId }: { bankId: number }) {
  const toast = useToast();
  const [sr1, setSr1] = useState<number | null>(null);
  const [sr2, setSr2] = useState<number | null>(null);
  const srCats = useTrackingCategories();
  const [type, setType] = useState<'SPEND' | 'RECEIVE'>('SPEND');
  const [contact, setContact] = useState<number | ''>('');
  const [date, setDate] = useState(todayIso());
  const [ref, setRef] = useState('');
  const [desc, setDesc] = useState('');
  const [amount, setAmount] = useState('');
  const [account, setAccount] = useState<number | ''>('');
  const [taxRate, setTaxRate] = useState<number | null>(2);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setErr(null);
    if (!account || !toCents(amount)) return setErr('Enter an amount and choose an account');
    try {
      await api('banking.createBankTransaction', {
        type, bank_account_id: bankId, contact_id: contact || undefined, date, reference: ref,
        line_amount_type: 'INCLUSIVE',
        lines: [{ description: desc || ref || 'Bank transaction', quantity: 1, unit_amount: toCents(amount), account_id: account, tax_rate_id: taxRate, tracking_option_1: sr1, tracking_option_2: sr2 }],
      });
      toast(`${type === 'SPEND' ? 'Spend' : 'Receive'} money recorded`);
      setAmount(''); setDesc(''); setRef('');
    } catch (e: any) { setErr(e.message); }
  }

  return (
    <div className="card" style={{ maxWidth: 720 }}>
      <ErrorBanner msg={err} />
      <h2>Spend or receive money</h2>
      <p className="muted small">Direct bank transactions that aren't tied to an invoice or bill — fees, interest, owner drawings, and so on. Amounts are tax inclusive.</p>
      <div className="form-row">
        <Field label="Type">
          <select value={type} onChange={(e) => setType(e.target.value as any)}>
            <option value="SPEND">Spend money</option><option value="RECEIVE">Receive money</option>
          </select>
        </Field>
        <Field label="Date"><DateField value={date} onChange={setDate} /></Field>
        <Field label="Amount"><input className="num" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" /></Field>
      </div>
      <div className="form-row">
        <Field label="Contact (optional)"><PickContact value={contact} onChange={setContact} /></Field>
        <Field label="Account"><PickAccount value={account} onChange={setAccount} /></Field>
        <Field label="Tax rate"><PickTaxRate value={taxRate} onChange={setTaxRate} /></Field>
      </div>
      <div className="form-row">
        <Field label="Reference"><input value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
        <Field label="Description"><input value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
      </div>
      {srCats.length > 0 && (
        <div className="form-row">
          <Field label="Tracking">
            <div style={{ display: 'flex', gap: 8 }}>
              <TrackingSelects categories={srCats} value1={sr1} value2={sr2} onChange={(a, b) => { setSr1(a); setSr2(b); }} />
            </div>
          </Field>
        </div>
      )}
      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn primary" onClick={submit}>Record</button>
      </div>
    </div>
  );
}


function TransferMoney({ bankId }: { bankId: number }) {
  const toast = useToast();
  const { data: accounts, reload: reloadAccts } = useApi<any[]>('banking.accounts');
  const { data: transfers, reload } = useApi<any[]>('banking.listTransfers', {});
  const banks = (accounts ?? []);
  const [fromId, setFromId] = useState<number | ''>(bankId);
  const [toId, setToId] = useState<number | ''>('');
  const [date, setDate] = useState(todayIso());
  const [amount, setAmount] = useState('');
  const [ref, setRef] = useState('');
  const [diffAmt, setDiffAmt] = useState(false);
  const [toAmount, setToAmount] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setErr(null);
    const cents = toCents(amount);
    if (fromId === '' || toId === '') return setErr('Choose both accounts');
    if (fromId === toId) return setErr('The "from" and "to" accounts must be different');
    if (!cents) return setErr('Enter an amount greater than zero');
    setBusy(true);
    try {
      await api('banking.createTransfer', {
        date, from_account_id: fromId, to_account_id: toId, amount: cents,
        to_amount: diffAmt && toCents(toAmount) ? toCents(toAmount) : undefined,
        reference: ref || undefined,
      });
      toast('Transfer recorded');
      setAmount(''); setRef(''); setToAmount(''); setDiffAmt(false);
      reload(); reloadAccts();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }

  const bankOpts = banks.map((a) => ({ id: a.id, label: `${a.code} ${a.name}` }));
  return (
    <div className="card" style={{ maxWidth: 720 }}>
      <ErrorBanner msg={err} />
      <h2>Transfer money between accounts</h2>
      <p className="muted small">Move money between two of your own bank accounts. This isn't income or expense — it just reduces one balance and increases the other.</p>
      {banks.length < 2 ? (
        <p className="muted">You need at least two bank accounts to make a transfer. Add another in the chart of accounts (mark it as a bank account).</p>
      ) : (
        <>
          <div className="form-row">
            <Field label="From account">
              <SearchSelect value={fromId} onChange={(v) => setFromId(v)} options={bankOpts} placeholder="From…" />
            </Field>
            <Field label="To account">
              <SearchSelect value={toId} onChange={(v) => setToId(v)} options={bankOpts.filter((o) => o.id !== fromId)} placeholder="To…" />
            </Field>
          </div>
          <div className="form-row">
            <Field label="Date"><DateField value={date} onChange={setDate} /></Field>
            <Field label="Amount"><input className="num" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" /></Field>
            <Field label="Reference"><input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="optional" /></Field>
          </div>
          <label className="check" style={{ marginBottom: 8 }}>
            <input type="checkbox" checked={diffAmt} onChange={(e) => setDiffAmt(e.target.checked)} /> Different amount received (cross-currency)
          </label>
          {diffAmt && (
            <div className="form-row">
              <Field label="Amount received in the “to” account"><input className="num" value={toAmount} onChange={(e) => setToAmount(e.target.value)} placeholder="0.00" /></Field>
            </div>
          )}
          <div className="btn-row" style={{ marginTop: 12 }}>
            <button className="btn primary" disabled={busy} onClick={submit}>Record transfer</button>
          </div>
        </>
      )}

      {(transfers ?? []).length > 0 && (
        <div style={{ marginTop: 22 }}>
          <h3>Recent transfers</h3>
          <table className="tbl">
            <thead><tr><th>Date</th><th>From</th><th>To</th><th>Reference</th><th className="num">Amount</th><th /></tr></thead>
            <tbody>
              {(transfers ?? []).map((t: any) => (
                <tr key={t.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(t.date)}</td>
                  <td className="small">{t.from_name}</td>
                  <td className="small">{t.to_name}</td>
                  <td className="small">{t.reference}</td>
                  <td className="num"><Money cents={t.amount} />{t.to_amount && t.to_amount !== t.amount ? <span className="faint small"> → <Money cents={t.to_amount} /></span> : null}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn small danger" onClick={async () => {
                      if (!window.confirm('Void this transfer? Its ledger entry will be reversed.')) return;
                      try { await api('banking.voidTransfer', t.id); toast('Transfer voided'); reload(); reloadAccts(); }
                      catch (e: any) { setErr(e.message); }
                    }}>Void</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function BankFeeds({ bankId }: { bankId: number }) {
  const { data: feeds, reload } = useApi<any[]>('bankfeeds.list');
  const { data: providers } = useApi<any[]>('bankfeeds.availableProviders');
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  // Feeds for THIS bank account.
  const mine = (feeds ?? []).filter((f: any) => f.bank_account_id === bankId);
  const active = mine.find((f: any) => f.status === 'ACTIVE');

  async function connect(provider: string) {
    setBusy(true);
    try { await api('bankfeeds.connect', { bank_account_id: bankId, provider }); toast('Feed connected'); reload(); }
    catch (e: any) { toast(e.message); } finally { setBusy(false); }
  }
  async function sync(id: number) {
    setBusy(true);
    try { const r = await api('bankfeeds.sync', id); toast(r.imported > 0 ? `Imported ${r.imported} new transaction(s)` : (r.duplicates > 0 ? 'No new transactions (already up to date)' : 'No transactions returned')); reload(); }
    catch (e: any) { toast(e.message); } finally { setBusy(false); }
  }
  async function disconnect(id: number) {
    setBusy(true);
    try { await api('bankfeeds.disconnect', id); toast('Feed disconnected'); reload(); }
    catch (e: any) { toast(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="card" style={{ maxWidth: 760 }}>
      <h2>Bank feeds</h2>
      <p className="muted small">
        A feed pulls transactions straight into this account’s reconciliation list — no CSV needed. Pulled transactions are
        de-duplicated, so refreshing never imports the same line twice.
      </p>

      {active ? (
        <div className="feed-row">
          <div>
            <strong>{active.provider_label ?? active.provider}</strong>
            {!active.live && <span className="badge amber" style={{ marginLeft: 8 }}>simulated</span>}
            <div className="muted small">{active.last_refresh_at ? `Last refreshed ${fmtDate(String(active.last_refresh_at).slice(0, 10))}` : 'Not refreshed yet'}</div>
          </div>
          <div className="grow" />
          <button className="btn primary" disabled={busy} onClick={() => sync(active.id)}>Refresh now</button>
          <button className="btn small danger" disabled={busy} onClick={() => disconnect(active.id)}>Disconnect</button>
        </div>
      ) : (
        <div>
          <p className="small">Connect a feed:</p>
          <div className="btn-row">
            {(providers ?? []).map((p: any) => (
              <button key={p.key} className="btn" disabled={busy} onClick={() => connect(p.key)}>
                Connect {p.label}{!p.live ? '' : ''}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="info-bar" style={{ marginTop: 14 }}>
        The <strong>Sandbox</strong> feed imports simulated transactions so you can try feeds and reconciliation. A live feed to your
        real bank needs the hosted server edition plus a paid bank-data provider (e.g. Plaid) — once configured it appears here and
        works the same way.
      </div>
    </div>
  );
}
