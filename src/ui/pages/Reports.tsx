import React, { useMemo, useRef, useState, useEffect } from 'react';
import { useApi, useToast, Spinner, ErrorBanner, Empty, Modal, openSource, useTrackingCategories, MultiPick, Popover, useColumns, PickContact } from '../components';
import { DateField, Field } from '../components';
import { api, money, fmtDate, todayIso, toCents, saveCsv, exportPdf } from '../api';
import { plWindows, bsSnapshots } from '../../shared/periods';

const REPORTS = [
  { id: 'profit_and_loss', label: 'Profit & Loss', range: true },
  { id: 'project_profitability', label: 'Project Profitability', range: true },
  { id: 'project_pl', label: 'Project P&L', range: true },
  { id: 'customer_statement', label: 'Customer Statement', range: true },
  { id: 'transaction_summary', label: 'Custom Summary', range: true },
  { id: 'balance_sheet', label: 'Balance Sheet', range: false },
  { id: 'trial_balance', label: 'Trial Balance', range: false },
  { id: 'general_ledger', label: 'General Ledger', range: true },
  { id: 'account_statement', label: 'Account Statement', range: true },
  { id: 'cash_flow', label: 'Cash Flow', range: true },
  { id: 'inventory_valuation', label: 'Inventory Valuation', range: false },
  { id: 'aged_receivables', label: 'Aged Receivables', range: false },
  { id: 'aged_receivables_detail', label: 'Aged Receivables — Detail', range: false },
  { id: 'aged_payables', label: 'Aged Payables', range: false },
  { id: 'aged_payables_detail', label: 'Aged Payables — Detail', range: false },
  { id: 'tax_summary', label: 'Tax Summary', range: true },
];

const SOURCE_LABEL: Record<string, string> = {
  INVOICE: 'Invoice', BILL: 'Bill', PAYMENT: 'Payment', BANKTXN: 'Bank transaction',
  TRANSFER: 'Transfer', MANUAL: 'Manual journal', DEPRN: 'Depreciation', DISPOSAL: 'Asset disposal',
};

const trackingOf = (l: any) => [l.tracking_1, l.tracking_2].filter(Boolean).join(' · ');

// ── Filter / column state per report ───────────────────────────────────────

type GLCols = { journal: boolean; doc: boolean; reference: boolean; source: boolean; description: boolean; contact: boolean; acct_type: boolean; tracking: boolean; drcr: boolean; balance: boolean };
type ASCols = { journal: boolean; doc: boolean; reference: boolean; source: boolean; account: boolean; acct_type: boolean; description: boolean; contact: boolean; tracking: boolean; drcr: boolean; balance: boolean };
type TBCols = { code: boolean; type: boolean; net: boolean };
type PLOpts = { codes: boolean; basis: string; count: number; accounting: 'ACCRUAL' | 'CASH' };

const GL_DEFAULT: GLCols = { journal: true, doc: false, reference: false, source: false, description: true, contact: false, acct_type: false, tracking: false, drcr: true, balance: true };
const AS_DEFAULT: ASCols = { journal: false, doc: true, reference: false, source: true, account: true, acct_type: false, description: true, contact: true, tracking: false, drcr: true, balance: true };
const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'];
const TB_DEFAULT: TBCols = { code: true, type: true, net: false };

export default function Reports() {
  const [report, setReport] = useState('profit_and_loss');
  const [from, setFrom] = useState(() => {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 2, 1)).toISOString().slice(0, 10);
  });
  const [to, setTo] = useState(todayIso());

  // General Ledger
  const [glAccounts, setGlAccounts] = useState<Array<number | string>>([]);
  const [glTypes, setGlTypes] = useState<Array<number | string>>([]);
  const [glContacts, setGlContacts] = useState<Array<number | string>>([]);
  const [glSources, setGlSources] = useState<Array<number | string>>([]);
  const [glSearch, setGlSearch] = useState('');
  const [glCols, setGlCols] = useColumns<GLCols>('gl', GL_DEFAULT);
  // Account Statement
  const [asAccounts, setAsAccounts] = useState<Array<number | string>>([]);
  const [asTypes, setAsTypes] = useState<Array<number | string>>([]);
  const [asContacts, setAsContacts] = useState<Array<number | string>>([]);
  const [asSources, setAsSources] = useState<Array<number | string>>([]);
  const [asSearch, setAsSearch] = useState('');
  const [asGroup, setAsGroup] = useState('');
  const [asCols, setAsCols] = useColumns<ASCols>('account-statement', AS_DEFAULT);
  // Trial Balance
  const [tbTypes, setTbTypes] = useState<Array<number | string>>([]);
  const [tbSearch, setTbSearch] = useState('');
  const [tbHideZero, setTbHideZero] = useState(true);
  const [tbCols, setTbCols] = useColumns<TBCols>('trial-balance', TB_DEFAULT);
  // P&L
  const [pl, setPl] = useState<PLOpts>({ codes: true, basis: 'none', count: 2, accounting: 'ACCRUAL' });
  const [bsBasis, setBsBasis] = useState('none');
  const [bsCount, setBsCount] = useState(2);
  const [bsRevalue, setBsRevalue] = useState(false);
  const [bsCashBasis, setBsCashBasis] = useState<'ACCRUAL' | 'CASH'>('ACCRUAL');
  const [ppCategory, setPpCategory] = useState<number | ''>('');
  const [ppBasis, setPpBasis] = useState<'ACCRUAL' | 'CASH'>('ACCRUAL');
  const [csContact, setCsContact] = useState<number | ''>('');
  const [csType, setCsType] = useState<'OUTSTANDING' | 'ACTIVITY'>('OUTSTANDING');
  const [tsGroup, setTsGroup] = useState<'account' | 'account_type' | 'contact' | 'source' | 'tracking_1' | 'tracking_2'>('account');
  const [tsPeriod, setTsPeriod] = useState<'none' | 'month' | 'quarter' | 'year'>('month');
  const [tracking, setTracking] = useState<number | ''>('');
  const trackingCats = useTrackingCategories();
  const [drill, setDrill] = useState<any | null>(null);
  // Aged
  const [agedSearch, setAgedSearch] = useState('');
  // Shared
  const [showCodes, setShowCodes] = useState(true);

  // ── Saved report views ────────────────────────────────────────────────────
  const { data: savedList, reload: reloadSaved } = useApi<any[]>('savedreports.list');
  const [loadedView, setLoadedView] = useState<{ id: number; name: string } | null>(null);
  const toast = useToast();

  // Capture every setting that defines the current report, so it can be re-run.
  function currentConfig() {
    return {
      report, from, to, showCodes,
      glAccounts, glTypes, glContacts, glSources, glSearch, glCols,
      asAccounts, asTypes, asContacts, asSources, asSearch, asGroup, asCols, tsGroup, tsPeriod,
      tbTypes, tbSearch, tbHideZero, tbCols,
      pl, bsBasis, bsCount, tracking, agedSearch,
    };
  }
  function applyConfig(c: any) {
    if (!c) return;
    if (c.report) setReport(c.report);
    if (c.from != null) setFrom(c.from);
    if (c.to != null) setTo(c.to);
    if (c.showCodes != null) setShowCodes(c.showCodes);
    setGlAccounts(c.glAccounts ?? []); setGlTypes(c.glTypes ?? []); setGlContacts(c.glContacts ?? []);
    setGlSources(c.glSources ?? []); setGlSearch(c.glSearch ?? ''); if (c.glCols) setGlCols(c.glCols);
    setAsAccounts(c.asAccounts ?? []); setAsTypes(c.asTypes ?? []); setAsContacts(c.asContacts ?? []);
    setAsSources(c.asSources ?? []); setAsSearch(c.asSearch ?? ''); setAsGroup(c.asGroup ?? ''); if (c.asCols) setAsCols(c.asCols);
    if (c.tsGroup) setTsGroup(c.tsGroup); if (c.tsPeriod) setTsPeriod(c.tsPeriod);
    setTbTypes(c.tbTypes ?? []); setTbSearch(c.tbSearch ?? ''); if (c.tbHideZero != null) setTbHideZero(c.tbHideZero); if (c.tbCols) setTbCols(c.tbCols);
    if (c.pl) setPl(c.pl); if (c.bsBasis != null) setBsBasis(c.bsBasis); if (c.bsCount != null) setBsCount(c.bsCount);
    if (c.tracking !== undefined) setTracking(c.tracking); if (c.agedSearch != null) setAgedSearch(c.agedSearch);
  }

  async function loadView(id: number) {
    if (!id) { setLoadedView(null); return; }
    try {
      const v: any = await api('savedreports.get', id);
      applyConfig(v.config);
      setLoadedView({ id: v.id, name: v.name });
      toast(`Loaded “${v.name}”`);
    } catch (e: any) { toast(e.message); }
  }
  async function saveView(asNew: boolean) {
    const suggested = asNew ? '' : (loadedView?.name ?? '');
    const name = window.prompt(asNew ? 'Save this report as:' : 'Update the saved report name:', suggested);
    if (name == null || !name.trim()) return;
    try {
      const id = await api('savedreports.save', { id: asNew ? undefined : loadedView?.id, name: name.trim(), report_type: report, config: currentConfig() });
      setLoadedView({ id: id as number, name: name.trim() });
      reloadSaved();
      toast('Report saved');
    } catch (e: any) { toast(e.message); }
  }
  async function deleteView() {
    if (!loadedView) return;
    if (!window.confirm(`Delete the saved report “${loadedView.name}”?`)) return;
    try { await api('savedreports.remove', loadedView.id); setLoadedView(null); reloadSaved(); toast('Saved report deleted'); }
    catch (e: any) { toast(e.message); }
  }

  const { data: allAccounts } = useApi<any[]>('accounts.list', {});
  const { data: allContacts } = useApi<any[]>('contacts.list', {});
  const accountOptions = (allAccounts ?? []).map((a: any) => ({ id: a.id, label: `${a.code} ${a.name}` }));
  const contactOptions = (allContacts ?? []).map((c: any) => ({ id: c.id, label: c.name }));
  const sourceOptions = Object.entries(SOURCE_LABEL).map(([k, v]) => ({ id: k, label: v }));
  const typeOptions = ACCOUNT_TYPES.map((t) => ({ id: t, label: t }));

  const def = REPORTS.find((r) => r.id === report)!;
  const params: any = def.range ? { report, from, to } : { report, as_at: to };
  if (report === 'account_statement') {
    if (asAccounts.length) params.account_ids = asAccounts;
    if (asContacts.length) params.contact_ids = asContacts;
    if (asSources.length) params.source_types = asSources;
    if (asTypes.length) params.account_types = asTypes;
    if (asSearch.trim()) params.search = asSearch.trim();
  }
  if (report === 'profit_and_loss') {
    if (pl.basis !== 'none' && pl.count > 0) params.compare = plWindows(pl.basis, from, to, Math.min(pl.count, 12));
    if (tracking) params.tracking_option_id = tracking;
    if (pl.accounting === 'CASH') params.basis = 'CASH';
  }
  if (report === 'transaction_summary') {
    if (asAccounts.length) params.account_ids = asAccounts;
    if (asContacts.length) params.contact_ids = asContacts;
    if (asSources.length) params.source_types = asSources;
    if (asTypes.length) params.account_types = asTypes;
    if (asSearch.trim()) params.search = asSearch.trim();
    params.group_by = tsGroup;
    params.period = tsPeriod;
  }
  if (report === 'customer_statement') {
    if (csContact) params.contact_id = csContact;
    params.type = csType;
    params.as_at = to;
  }
  if (report === 'project_profitability') {
    if (ppCategory) params.category_id = ppCategory;
    if (ppBasis === 'CASH') params.basis = 'CASH';
  }
  if (report === 'inventory_valuation') {
    params.as_at = to;
  }
  if (report === 'balance_sheet' && bsBasis !== 'none' && bsCount > 0) {
    params.compare = bsSnapshots(bsBasis, to, Math.min(bsCount, 12));
  }
  if (report === 'balance_sheet' && bsRevalue) params.revalue = true;
  if (report === 'balance_sheet' && bsCashBasis === 'CASH') params.basis = 'CASH';

  return (
    <>
      <div className="page-head">
        <h1>Reports</h1>
        <div className="grow" />
        <select style={{ width: 200 }} value={report} onChange={(e) => setReport(e.target.value)}>
          {REPORTS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
        {def.range && <DateField style={{ width: 148 }} value={from} onChange={setFrom} label="from date" />}
        <DateField style={{ width: 148 }} value={to} onChange={setTo} label="to date" />
        <ExportButtons params={params} title={def.label} />
      </div>

      {/* Saved report views */}
      <div className="saved-bar">
        <span className="saved-label">Saved reports:</span>
        <select
          className="saved-select"
          value={loadedView?.id ?? ''}
          onChange={(e) => loadView(Number(e.target.value))}
        >
          <option value="">— choose a saved report —</option>
          {(savedList ?? []).map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
        {loadedView ? (
          <>
            <button className="btn small" onClick={() => saveView(false)} title="Save changes to this report">Update</button>
            <button className="btn small" onClick={() => saveView(true)} title="Save as a new report">Save as new</button>
            <button className="btn small danger" onClick={deleteView}>Delete</button>
            <span className="muted small">Editing “{loadedView.name}” — adjust anything and Update.</span>
          </>
        ) : (
          <button className="btn small" onClick={() => saveView(true)} title="Save the current report setup">+ Save current view</button>
        )}
      </div>

      {/* Per-report filter & column toolbar */}
      <div className="report-toolbar">
        {report === 'general_ledger' && (
          <>
            <MultiPick label="Accounts" options={accountOptions} value={glAccounts} onChange={setGlAccounts} searchable width={250} />
            <MultiPick label="Types" options={typeOptions} value={glTypes} onChange={setGlTypes} width={130} />
            <MultiPick label="Contacts" options={contactOptions} value={glContacts} onChange={setGlContacts} searchable width={230} />
            <MultiPick label="Sources" options={sourceOptions} value={glSources} onChange={setGlSources} width={160} />
            <input placeholder="Search description, journal #…" value={glSearch} onChange={(e) => setGlSearch(e.target.value)} style={{ width: 220 }} />
            <ColumnPicker
              options={[
                ['journal', 'Journal # (JE#)'], ['doc', 'Document # (Inv/Bill/Credit)'], ['reference', 'Reference'],
                ['source', 'Source'], ['description', 'Description'], ['contact', 'Contact'],
                ['acct_type', 'Account type'], ['tracking', 'Tracking'],
                ['drcr', 'Debit / Credit split'], ['balance', 'Running balance'],
              ]}
              value={glCols as any}
              onChange={(v) => setGlCols(v as GLCols)}
            />
          </>
        )}
        {report === 'transaction_summary' && (
          <>
            <MultiPick label="Accounts" options={accountOptions} value={asAccounts} onChange={setAsAccounts} searchable width={230} />
            <MultiPick label="Types" options={typeOptions} value={asTypes} onChange={setAsTypes} width={130} />
            <MultiPick label="Contacts" options={contactOptions} value={asContacts} onChange={setAsContacts} searchable width={210} />
            <MultiPick label="Sources" options={sourceOptions} value={asSources} onChange={setAsSources} width={150} />
            <input placeholder="Search…" value={asSearch} onChange={(e) => setAsSearch(e.target.value)} style={{ width: 130 }} />
            <select value={tsGroup} onChange={(e) => setTsGroup(e.target.value as any)} style={{ width: 180 }} title="Rows of the summary">
              <option value="account">Rows: account</option>
              <option value="account_type">Rows: account type</option>
              <option value="contact">Rows: contact</option>
              <option value="source">Rows: source</option>
              {trackingCats.map((c: any, i: number) => <option key={c.id} value={`tracking_${i + 1}`}>Rows: {c.name}</option>)}
            </select>
            <select value={tsPeriod} onChange={(e) => setTsPeriod(e.target.value as any)} style={{ width: 150 }} title="Columns by period">
              <option value="none">Columns: total only</option>
              <option value="month">Columns: by month</option>
              <option value="quarter">Columns: by quarter</option>
              <option value="year">Columns: by year</option>
            </select>
          </>
        )}
        {report === 'account_statement' && (
          <>
            <MultiPick label="Accounts" options={accountOptions} value={asAccounts} onChange={setAsAccounts} searchable width={250} />
            <MultiPick label="Types" options={typeOptions} value={asTypes} onChange={setAsTypes} width={130} />
            <MultiPick label="Contacts" options={contactOptions} value={asContacts} onChange={setAsContacts} searchable width={230} />
            <MultiPick label="Sources" options={sourceOptions} value={asSources} onChange={setAsSources} width={160} />
            <input placeholder="Search…" value={asSearch} onChange={(e) => setAsSearch(e.target.value)} style={{ width: 150 }} />
            <select value={asGroup} onChange={(e) => setAsGroup(e.target.value)} style={{ width: 185 }} title="Group the statement with subtotals">
              <option value="">No grouping</option>
              <option value="account">Group by account</option>
              <option value="contact">Group by contact</option>
              <option value="source">Group by source</option>
              <option value="acct_type">Group by account type</option>
              {trackingCats.map((c: any, i: number) => (
                <option key={c.id} value={`tracking_${i + 1}`}>Group by {c.name}</option>
              ))}
            </select>
            <ColumnPicker
              options={[
                ['journal', 'Journal # (JE#)'], ['doc', 'Document # (Inv/Bill/Credit)'], ['reference', 'Reference'],
                ['source', 'Source'], ['account', 'Account'], ['acct_type', 'Account type'],
                ['description', 'Description'], ['contact', 'Contact'], ['tracking', 'Tracking'],
                ['drcr', 'Debit / Credit split'], ['balance', 'Running balance'],
              ]}
              value={asCols as any}
              onChange={(v) => setAsCols(v as ASCols)}
            />
          </>
        )}
        {report === 'trial_balance' && (
          <>
            <MultiPick label="Types" options={typeOptions} value={tbTypes} onChange={setTbTypes} width={130} />
            <input placeholder="Search accounts…" value={tbSearch} onChange={(e) => setTbSearch(e.target.value)} style={{ width: 220 }} />
            <label className="check"><input type="checkbox" checked={tbHideZero} onChange={(e) => setTbHideZero(e.target.checked)} /> Hide zero balances</label>
            <ColumnPicker
              options={[['code', 'Account code'], ['type', 'Type'], ['net', 'Net column']]}
              value={tbCols as any}
              onChange={(v) => setTbCols(v as TBCols)}
            />
          </>
        )}
        {report === 'profit_and_loss' && (
          <>
            <select value={pl.accounting} onChange={(e) => setPl({ ...pl, accounting: e.target.value as any })} style={{ width: 150 }} title="Accrual counts documents on their date; cash counts money when it actually moves">
              <option value="ACCRUAL">Accrual basis</option>
              <option value="CASH">Cash basis</option>
            </select>
            <select value={pl.basis} onChange={(e) => setPl({ ...pl, basis: e.target.value })} style={{ width: 230 }}>
              <option value="none">No comparison</option>
              <option value="period">Compare: previous periods (same length)</option>
              <option value="month">Compare: monthly</option>
              <option value="quarter">Compare: quarterly</option>
              <option value="half">Compare: half-yearly</option>
              <option value="year">Compare: year on year</option>
            </select>
            {pl.basis !== 'none' && (
              <input
                type="number" min={1} max={12} value={pl.count} title="How many periods to compare"
                onChange={(e) => setPl({ ...pl, count: Math.max(1, Math.min(12, Number(e.target.value) || 1)) })}
                style={{ width: 64 }}
              />
            )}
            {trackingCats.length > 0 && (
              <select value={tracking} onChange={(e) => setTracking(e.target.value ? Number(e.target.value) : '')} style={{ width: 190 }}>
                <option value="">All tracking</option>
                {trackingCats.map((c: any) => (
                  <optgroup key={c.id} label={c.name}>
                    {c.options.map((o: any) => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </optgroup>
                ))}
              </select>
            )}
            <label className="check"><input type="checkbox" checked={pl.codes} onChange={(e) => setPl({ ...pl, codes: e.target.checked })} /> Show account codes</label>
          </>
        )}
        {report === 'balance_sheet' && (
          <>
            <select value={bsCashBasis} onChange={(e) => setBsCashBasis(e.target.value as any)} style={{ width: 140 }}>
              <option value="ACCRUAL">Accrual basis</option>
              <option value="CASH">Cash basis</option>
            </select>
            <select value={bsBasis} onChange={(e) => setBsBasis(e.target.value)} style={{ width: 220 }}>
              <option value="none">No comparison</option>
              <option value="month_end">Compare: month ends</option>
              <option value="quarter_end">Compare: quarter ends</option>
              <option value="half_end">Compare: half-year ends</option>
              <option value="year_end">Compare: year ends</option>
            </select>
            {bsBasis !== 'none' && (
              <input
                type="number" min={1} max={12} value={bsCount} title="How many period ends to compare"
                onChange={(e) => setBsCount(Math.max(1, Math.min(12, Number(e.target.value) || 1)))}
                style={{ width: 64 }}
              />
            )}
            <label className="check"><input type="checkbox" checked={showCodes} onChange={(e) => setShowCodes(e.target.checked)} /> Show account codes</label>
            <label className="check" title="Restate open foreign-currency receivables and payables at the exchange rate as at the report date (presentation only — posts nothing)."><input type="checkbox" checked={bsRevalue} onChange={(e) => setBsRevalue(e.target.checked)} /> Revalue foreign balances</label>
          </>
        )}
        {report.startsWith('aged_') && (
          <input placeholder="Search contacts…" value={agedSearch} onChange={(e) => setAgedSearch(e.target.value)} style={{ width: 240 }} />
        )}
        {report === 'customer_statement' && (
          <>
            <div style={{ minWidth: 240 }}><PickContact value={csContact} onChange={(id) => setCsContact(id)} filter="CUSTOMERS" /></div>
            <select value={csType} onChange={(e) => setCsType(e.target.value as any)} style={{ width: 200 }}>
              <option value="OUTSTANDING">Outstanding (open items)</option>
              <option value="ACTIVITY">Activity (with running balance)</option>
            </select>
          </>
        )}
      </div>

      {/* key forces a clean remount per report+params: stale data can never render into the wrong report */}
      <ReportBody
        key={report + (report === 'account_statement' ? JSON.stringify([asAccounts, asContacts, asSources, asTypes, asSearch]) : '') + (report === 'balance_sheet' ? `${bsBasis}:${bsCount}:${bsRevalue}:${bsCashBasis}` : '') + (report === 'project_profitability' ? `${ppCategory}:${ppBasis}` : '') + (report === 'customer_statement' ? `${csContact}:${csType}` : '') + (report === 'transaction_summary' ? JSON.stringify([asAccounts, asContacts, asSources, asTypes, asSearch, tsGroup, tsPeriod]) : '')}
        params={params}
        ui={{ glAccounts, glTypes, glContacts, glSources, glSearch, glCols, asCols, asAccounts, asGroup, tbTypes, tbSearch, tbHideZero, tbCols, pl, agedSearch, showCodes, tracking, onDrill: setDrill }}
      />
      {drill && <DrillModal q={drill} onClose={() => setDrill(null)} />}
    </>
  );
}

// ── Column picker ──────────────────────────────────────────────────────────

function ColumnPicker({ options, value, onChange }: { options: [string, string][]; value: Record<string, boolean>; onChange: (v: Record<string, boolean>) => void }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={btnRef} type="button" className="filter-btn" onClick={() => setOpen(!open)}>
        <span className="filter-btn-text">Columns</span><span className="ss-caret-inline">▾</span>
      </button>
      {open && btnRef.current && (
        <Popover anchor={btnRef.current} align="right" width={210} onClose={() => setOpen(false)}>
          {options.map(([k, label]) => (
            <label key={k} className="check">
              <input type="checkbox" checked={!!value[k]} onChange={(e) => onChange({ ...value, [k]: e.target.checked })} /> {label}
            </label>
          ))}
        </Popover>
      )}
    </>
  );
}

// ── Export ─────────────────────────────────────────────────────────────────

function ExportButtons({ params, title }: { params: any; title: string }) {
  const [busy, setBusy] = useState(false);
  async function csv() {
    setBusy(true);
    try {
      const r = await api('reports.exportCsv', params);
      await saveCsv(r.csv, r.filename);
    } finally { setBusy(false); }
  }
  async function pdf() {
    setBusy(true);
    try {
      const el = document.getElementById('report-body');
      if (!el) return;
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>
        body{font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#1f2933;margin:40px;font-size:12.5px}
        h1{font-size:22px;margin:0 0 2px} .muted{color:#52606d} table{width:100%;border-collapse:collapse;margin-top:14px}
        th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#52606d;border-bottom:2px solid #1f2933;padding:7px 9px}
        td{padding:7px 9px;border-bottom:1px solid #e4e7eb} .num{text-align:right;white-space:nowrap}
        tr.total td{font-weight:700;border-top:2px solid #1f2933} tr.section td{font-weight:600;background:#f3f6f9;text-transform:uppercase;font-size:10.5px;color:#52606d}
        .badge,.expander{display:none}</style></head><body><h1>${title}</h1><div class="muted">${params.from ? `${params.from} to ${params.to}` : `As at ${params.as_at}`}</div>${el.innerHTML}</body></html>`;
      await exportPdf(html, `${params.report}.pdf`);
    } finally { setBusy(false); }
  }
  return (
    <div className="btn-row">
      <button className="btn" disabled={busy} onClick={csv}>Export CSV</button>
      <button className="btn" disabled={busy} onClick={pdf}>Export PDF</button>
    </div>
  );
}

// ── Body ───────────────────────────────────────────────────────────────────

function ReportBody({ params, ui }: { params: any; ui: any }) {
  const args = { ...params };
  const id = args.report;
  delete args.report;
  const method = {
    profit_and_loss: 'profitAndLoss', balance_sheet: 'balanceSheet', trial_balance: 'trialBalance',
    general_ledger: 'generalLedger', account_statement: 'accountStatement', aged_receivables: 'agedReceivables', aged_payables: 'agedPayables',
    aged_receivables_detail: 'agedReceivables', aged_payables_detail: 'agedPayables',
    cash_flow: 'cashFlow', tax_summary: 'taxSummary', project_profitability: 'trackingProfitability', project_pl: 'projectProfitability', inventory_valuation: 'inventoryValuation', customer_statement: 'customerStatement', transaction_summary: 'transactionSummary',
  }[id as string]!;
  const { data, error, loading } = useApi<any>(`reports.${method}`, args);

  if (loading || data == null) return error ? <ErrorBanner msg={error} /> : <Spinner />;
  if (error) return <ErrorBanner msg={error} />;
  return (
    <div className="card tight" id="report-body">
      {id === 'profit_and_loss' && <PL d={data} opts={ui.pl} tracking={ui.tracking} onDrill={ui.onDrill} />}
      {id === 'project_profitability' && <ProjectProfitability d={data} />}
      {id === 'project_pl' && <ProjectPL d={data} />}
      {id === 'inventory_valuation' && <InventoryValuation d={data} />}
      {id === 'customer_statement' && <CustomerStatement d={data} />}
      {id === 'transaction_summary' && <TransactionSummary d={data} />}
      {id === 'balance_sheet' && <BS d={data} showCodes={ui.showCodes} onDrill={ui.onDrill} />}
      {id === 'trial_balance' && <TB d={data} types={ui.tbTypes} search={ui.tbSearch} hideZero={ui.tbHideZero} cols={ui.tbCols} onDrill={ui.onDrill} />}
      {id === 'general_ledger' && <GL d={data} accounts={ui.glAccounts} types={ui.glTypes} contacts={ui.glContacts} sources={ui.glSources} search={ui.glSearch} cols={ui.glCols} />}
      {id === 'account_statement' && <Statement d={data} cols={ui.asCols} singleAccount={ui.asAccounts.length === 1} groupBy={ui.asGroup} />}
      {(id === 'aged_receivables' || id === 'aged_payables') && <Aged d={data} search={ui.agedSearch} />}
      {(id === 'aged_receivables_detail' || id === 'aged_payables_detail') && <AgedDetail d={data} search={ui.agedSearch} />}
      {id === 'cash_flow' && <CashFlow d={data} onDrill={ui.onDrill} />}
      {id === 'tax_summary' && <TaxSummary d={data} onDrill={ui.onDrill} />}
      {id === 'tax_summary' && <TaxReturnPanel from={data.from} to={data.to} net={data.net_tax} />}
    </div>
  );
}

const Row = ({ name, amount, indent }: { name: string; amount: number; indent?: boolean }) => (
  <tr><td style={indent ? { paddingLeft: 32 } : undefined}>{name}</td><td className="num">{money(amount)}</td></tr>
);
const SectionRow = ({ label, span = 2 }: { label: string; span?: number }) => <tr className="section"><td colSpan={span}>{label}</td></tr>;
const TotalRow = ({ label, amount }: { label: string; amount: number }) => (
  <tr className="total"><td>{label}</td><td className="num">{money(amount)}</td></tr>
);

// ── Profit & Loss (with optional prior-period comparison) ──────────────────

function PL({ d, opts, tracking, onDrill }: { d: any; opts: PLOpts; tracking: number | ''; onDrill: (q: DrillQuery) => void }) {
  const cmps: any[] = d.comparisons ?? [];
  const showVar = cmps.length === 1;
  const isCash = d.basis === 'CASH';
  // On the cash basis the figures are built from payments prorated across
  // documents — the ledger drill would show accrual entries that don't add
  // up to these cells, so drilling is honestly disabled here.
  const noDrill = isCash ? () => {} : onDrill;
  const nm = (r: any) => (opts.codes ? `${r.code} ${r.name}` : r.name);
  const cmpRow = (c: any, section: string, accountId: number) => c[section]?.find((x: any) => x.account_id === accountId);
  const drillQ = (r: any, from: string, to: string, label: string): DrillQuery => ({
    title: `${r.code} ${r.name} — ${label}`, account_id: r.account_id, from, to,
    tracking_option_id: tracking || undefined,
  });

  const Line = ({ section, r }: { section: 'income' | 'cogs' | 'expenses'; r: any }) => (
    <tr className={isCash ? '' : 'dbl'} title={isCash ? 'Switch to accrual basis to drill into the ledger' : 'Double-click for the transactions behind this number'}
      onDoubleClick={() => noDrill(drillQ(r, d.from, d.to, 'this period'))}>
      <td style={{ paddingLeft: 32 }}>{nm(r)}</td>
      <td className="num"><Drillable amount={r.amount} q={drillQ(r, d.from, d.to, 'this period')} onDrill={noDrill} /></td>
      {cmps.map((c) => {
        const cr = cmpRow(c, section, r.account_id);
        return <td key={c.label} className="num muted"><Drillable amount={cr?.amount ?? 0} q={drillQ(r, c.from, c.to, c.label)} onDrill={noDrill} blank /></td>;
      })}
      {showVar && <Variance now={r.amount} then={cmpRow(cmps[0], section, r.account_id)?.amount ?? 0} />}
    </tr>
  );
  const Total = ({ label, k }: { label: string; k: string }) => (
    <tr className="total">
      <td>{label}</td><td className="num">{money(d[k])}</td>
      {cmps.map((c) => <td key={c.label} className="num muted">{money(c[k])}</td>)}
      {showVar && <Variance now={d[k]} then={cmps[0][k]} />}
    </tr>
  );
  const span = 2 + cmps.length + (showVar ? 1 : 0);
  return (
    <>
    {isCash && (
      <p className="muted small" style={{ margin: '2px 0 10px' }}>
        Cash basis: income and costs are counted when money actually moves — invoices and bills appear as they're paid
        (part-payments count proportionally), non-cash entries like depreciation are excluded, and manual journals show
        only if flagged "show on cash basis". Because each part-payment is rounded as it's recognised, a fully-paid
        document can occasionally differ by a cent or two from its invoiced total.
      </p>
    )}
    <table className="tbl">
      {cmps.length > 0 && (
        <thead><tr><th /><th className="num">{d.from} – {d.to}</th>{cmps.map((c) => <th key={c.label} className="num">{c.label}</th>)}{showVar && <th className="num">Change</th>}</tr></thead>
      )}
      <tbody>
        <SectionRow label="Income" span={span} />
        {d.income.map((r: any) => <Line key={r.account_id} section="income" r={r} />)}
        <Total label="Total income" k="total_income" />
        {(d.cogs.length > 0 || cmps.some((c) => c.cogs.length > 0)) && (<>
          <SectionRow label="Cost of sales" span={span} />
          {d.cogs.map((r: any) => <Line key={r.account_id} section="cogs" r={r} />)}
          <Total label="Gross profit" k="gross_profit" />
        </>)}
        <SectionRow label="Operating expenses" span={span} />
        {d.expenses.map((r: any) => <Line key={r.account_id} section="expenses" r={r} />)}
        <Total label="Total expenses" k="total_expenses" />
        <Total label="Net profit" k="net_profit" />
      </tbody>
    </table>
    </>
  );
}

function Variance({ now, then }: { now: number; then: number }) {
  const diff = now - then;
  const color = diff === 0 ? undefined : diff > 0 ? 'var(--green)' : 'var(--red)';
  return <td className="num" style={{ color }}>{diff === 0 ? '—' : (diff > 0 ? '+' : '') + money(diff)}</td>;
}

// ── Balance Sheet ──────────────────────────────────────────────────────────

function BS({ d, showCodes, onDrill }: { d: any; showCodes: boolean; onDrill: (q: DrillQuery) => void }) {
  const cmps: any[] = d.comparisons ?? [];
  const nm = (r: any) => (showCodes && r.code ? `${r.code} ${r.name}` : r.name);
  const key = (r: any) => r.account_id || r.name;
  // Union the rows of every period so an account that only existed in an
  // older snapshot still gets a line (zero in the periods it's absent from).
  const union = (section: string) => {
    const out: any[] = [...d[section]];
    const seen = new Set(out.map(key));
    for (const c of cmps) for (const r of c[section] ?? []) if (!seen.has(key(r))) { seen.add(key(r)); out.push({ ...r, amount: 0 }); }
    return out;
  };
  const at = (c: any, section: string, r: any) => (c[section] ?? []).find((x: any) => key(x) === key(r))?.amount ?? 0;
  const cell = (r: any, amount: number, as_at: string) => r.account_id
    ? <Drillable amount={amount} q={{ title: `${r.code} ${r.name} — to ${as_at}`, account_id: r.account_id, to: as_at }} onDrill={onDrill} blank={cmps.length > 0} />
    : money(amount);
  const BRow = ({ r, section }: { r: any; section: string }) => (
    <tr className={r.account_id ? 'dbl' : ''} title={r.account_id ? 'Double-click for the transactions behind this number' : undefined}
      onDoubleClick={() => r.account_id && onDrill({ title: `${r.code} ${r.name} — to ${d.as_at}`, account_id: r.account_id, to: d.as_at })}>
      <td style={{ paddingLeft: 32 }}>{nm(r)}</td>
      <td className="num">{cell(r, r.amount ?? at(d, section, r), d.as_at)}</td>
      {cmps.map((c) => <td key={c.label} className="num muted">{cell(r, at(c, section, r), c.as_at)}</td>)}
    </tr>
  );
  const Tot = ({ label, k }: { label: string; k: string }) => (
    <tr className="total"><td>{label}</td><td className="num">{money(d[k])}</td>
      {cmps.map((c) => <td key={c.label} className="num muted">{money(c[k])}</td>)}</tr>
  );
  const span = 2 + cmps.length;
  return (
    <table className="tbl">
      {(d.revalued_fx || d.cash_basis) && (
        <caption className="muted small" style={{ captionSide: 'top', textAlign: 'left', margin: '0 0 8px' }}>
          {d.cash_basis && 'Cash basis: receivables, payables and the GST on unsettled amounts are excluded (income and expenses count only as cash moves). '}
          {d.revalued_fx && `Foreign receivables & payables are revalued at the rate as at ${fmtDate(d.as_at)} (presentation only — nothing is posted); the difference shows as “Unrealised currency gains/(losses)”.`}
        </caption>
      )}
      {cmps.length > 0 && (
        <thead><tr><th /><th className="num">As at {fmtDate(d.as_at)}</th>{cmps.map((c) => <th key={c.label} className="num">{c.label}</th>)}</tr></thead>
      )}
      <tbody>
        <SectionRow label="Assets" span={span} />
        {union('assets').map((r: any) => <BRow key={key(r)} r={r} section="assets" />)}
        <Tot label="Total assets" k="total_assets" />
        <SectionRow label="Liabilities" span={span} />
        {union('liabilities').map((r: any) => <BRow key={key(r)} r={r} section="liabilities" />)}
        <Tot label="Total liabilities" k="total_liabilities" />
        <SectionRow label="Equity" span={span} />
        {union('equity').map((r: any) => <BRow key={key(r)} r={r} section="equity" />)}
        <Tot label="Total equity" k="total_equity" />
        <tr><td colSpan={span} style={{ textAlign: 'center' }}>
          {[d, ...cmps].every((c: any) => c.balances)
            ? <span className="badge green">Assets = Liabilities + Equity ✓{cmps.length ? ' (every period)' : ''}</span>
            : <span className="badge red">Out of balance!</span>}
        </td></tr>
      </tbody>
    </table>
  );
}

// ── Trial Balance ──────────────────────────────────────────────────────────

function TB({ d, types, search, hideZero, cols, onDrill }: { d: any; types: Array<string | number>; search: string; hideZero: boolean; cols: TBCols; onDrill: (q: DrillQuery) => void }) {
  const q = search.trim().toLowerCase();
  const typeSet = new Set(types);
  const rows = (d.rows ?? []).filter((r: any) => {
    if (typeSet.size && !typeSet.has(r.type)) return false;
    if (hideZero && r.debit === 0 && r.credit === 0) return false;
    if (q && !`${r.code} ${r.name}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const filtered = rows.length !== (d.rows ?? []).length;
  const sum = (k: 'debit' | 'credit') => rows.reduce((s: number, r: any) => s + r[k], 0);
  if (!rows.length) return <Empty title="No accounts match these filters" />;
  return (
    <table className="tbl">
      <thead><tr>
        <th>Account</th>
        {cols.type && <th>Type</th>}
        <th className="num">Debit</th><th className="num">Credit</th>
        {cols.net && <th className="num">Net</th>}
      </tr></thead>
      <tbody>
        {rows.map((r: any) => (
          <tr key={r.account_id} className="dbl" title="Double-click for the transactions behind this account"
            onDoubleClick={() => onDrill({ title: `${r.code} ${r.name} — to ${d.as_at}`, account_id: r.account_id, to: d.as_at })}>
            <td>{cols.code ? `${r.code} ` : ''}{r.name}</td>
            {cols.type && <td className="small muted">{r.type}</td>}
            <td className="num">{r.debit ? <Drillable amount={r.debit} q={{ title: `${r.code} ${r.name} — to ${d.as_at}`, account_id: r.account_id, to: d.as_at }} onDrill={onDrill} /> : ''}</td>
            <td className="num">{r.credit ? <Drillable amount={r.credit} q={{ title: `${r.code} ${r.name} — to ${d.as_at}`, account_id: r.account_id, to: d.as_at }} onDrill={onDrill} /> : ''}</td>
            {cols.net && <td className="num">{money(r.debit - r.credit)}</td>}
          </tr>
        ))}
        <tr className="total">
          <td colSpan={cols.type ? 2 : 1}>{filtered ? 'Filtered totals' : 'Totals'}</td>
          <td className="num">{money(sum('debit'))}</td>
          <td className="num">{money(sum('credit'))}</td>
          {cols.net && <td className="num">{money(sum('debit') - sum('credit'))}</td>}
        </tr>
        {filtered && (
          <tr><td colSpan={6} className="muted small" style={{ textAlign: 'center' }}>
            Showing {rows.length} of {(d.rows ?? []).length} accounts · full ledger totals: {money(d.total_debit)} / {money(d.total_credit)}
          </td></tr>
        )}
      </tbody>
    </table>
  );
}

// ── General Ledger ─────────────────────────────────────────────────────────

function GL({ d, accounts: accSel, types, contacts, sources, search, cols }: { d: any[]; accounts: Array<number | string>; types: Array<number | string>; contacts: Array<number | string>; sources: Array<number | string>; search: string; cols: GLCols }) {
  const q = search.trim().toLowerCase();
  const accSet = new Set(accSel);
  const typeSet = new Set(types);
  const contactSet = new Set(contacts);
  const sourceSet = new Set(sources);
  const lineFiltering = !!(q || contactSet.size || sourceSet.size);
  const filtering = lineFiltering || !!accSet.size || !!typeSet.size;
  const accounts = useMemo(() => {
    return (d ?? [])
      .filter((a) => (!accSet.size || accSet.has(a.id)) && (!typeSet.size || typeSet.has(a.type)))
      .map((a) => ({
        ...a,
        lines: a.lines.filter((l: any) => {
          if (sourceSet.size && !sourceSet.has(l.source_type)) return false;
          if (contactSet.size && !contactSet.has(l.contact_id)) return false;
          if (q) {
            const hay = `${l.description ?? ''} ${l.narration ?? ''} ${l.journal_number ?? ''} ${l.contact_name ?? ''} ${l.doc_number ?? ''} ${l.doc_reference ?? ''} ${trackingOf(l)}`.toLowerCase();
            if (!hay.includes(q)) return false;
          }
          return true;
        }),
      }))
      .filter((a) => a.lines.length > 0 || !filtering);
  }, [d, accSel, types, contacts, sources, q]);

  if (!accounts.length) return <Empty title="No activity matches" sub="Try widening the date range or clearing filters." />;

  const showBalance = cols.balance && !lineFiltering; // a running balance over filtered rows would lie
  const span = 1 + (cols.journal ? 1 : 0) + (cols.doc ? 1 : 0) + (cols.reference ? 1 : 0) + (cols.source ? 1 : 0) + (cols.description ? 1 : 0) + (cols.contact ? 1 : 0) + (cols.tracking ? 1 : 0);

  return (
    <>
      {lineFiltering && cols.balance && (
        <div className="muted small" style={{ padding: '8px 14px' }}>Running balance is hidden while filters are active — it's only meaningful over the complete account history.</div>
      )}
      <table className="tbl">
        <thead><tr>
          <th>Date</th>
          {cols.journal && <th>Journal</th>}
          {cols.doc && <th>Document #</th>}
          {cols.reference && <th>Reference</th>}
          {cols.source && <th>Source</th>}
          {cols.description && <th>Description</th>}
          {cols.contact && <th>Contact</th>}
          {cols.tracking && <th>Tracking</th>}
          {cols.drcr ? (<><th className="num">Debit</th><th className="num">Credit</th></>) : <th className="num">Amount</th>}
          {showBalance && <th className="num">Balance</th>}
        </tr></thead>
        <tbody>
          {accounts.map((a) => (
            <React.Fragment key={a.id}>
              <tr className="section">
                <td colSpan={span}>{a.code} {a.name}{cols.acct_type && <span className="muted"> · {a.type}</span>}</td>
                {cols.drcr ? <td className="num" colSpan={2}>{showBalance ? 'opening' : ''}</td> : <td className="num">{showBalance ? 'opening' : ''}</td>}
                {showBalance && <td className="num">{money(a.opening)}</td>}
              </tr>
              {a.lines.map((l: any, i: number) => (
                <tr key={`${l.journal_id}-${i}`} className="click" title="Open transaction" onClick={() => openSource(l.source_type, l.source_id)}>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(l.date)}</td>
                  {cols.journal && <td className="mono small">{l.journal_number}</td>}
                  {cols.doc && <td className="mono small">{l.doc_number ?? ''}</td>}
                  {cols.reference && <td className="small">{l.doc_reference ?? ''}</td>}
                  {cols.source && <td className="small muted">{SOURCE_LABEL[l.source_type] ?? l.source_type}</td>}
                  {cols.description && <td>{l.description ?? l.narration}</td>}
                  {cols.contact && <td className="small">{l.contact_name ?? ''}</td>}
                  {cols.tracking && <td className="small muted">{trackingOf(l)}</td>}
                  {cols.drcr ? (
                    <>
                      <td className="num">{l.debit ? money(l.debit) : ''}</td>
                      <td className="num">{l.credit ? money(l.credit) : ''}</td>
                    </>
                  ) : (
                    <td className="num">{money(l.debit - l.credit)}</td>
                  )}
                  {showBalance && <td className="num">{money(l.balance)}</td>}
                </tr>
              ))}
              {showBalance && (
                <tr className="total">
                  <td colSpan={span}>Closing — {a.code} {a.name}</td>
                  {cols.drcr && <td />}
                  <td className="num" colSpan={1}>{''}</td>
                  <td className="num">{money(a.closing)}</td>
                </tr>
              )}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </>
  );
}

// ── Aged AR / AP (expandable rows) ─────────────────────────────────────────

function Aged({ d, search }: { d: any; search: string }) {
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const q = search.trim().toLowerCase();
  const contacts = (d.contacts ?? []).filter((c: any) => !q || c.contact_name.toLowerCase().includes(q));
  if (!contacts.length) return <Empty title="Nothing outstanding" sub={q ? 'No contacts match that search.' : undefined} />;
  const filtered = contacts.length !== (d.contacts ?? []).length;
  const sum = (k: string) => contacts.reduce((s: number, c: any) => s + c[k], 0);
  return (
    <table className="tbl">
      <thead><tr><th>Contact</th><th className="num">Current</th><th className="num">1–30</th><th className="num">31–60</th><th className="num">61–90</th><th className="num">90+</th><th className="num">Total</th></tr></thead>
      <tbody>
        {contacts.map((c: any) => (
          <React.Fragment key={c.contact_id}>
            <tr style={{ cursor: 'pointer' }} onClick={() => setOpen({ ...open, [c.contact_id]: !open[c.contact_id] })}>
              <td><span className="expander">{open[c.contact_id] ? '▾' : '▸'}</span> <strong>{c.contact_name}</strong></td>
              <td className="num">{money(c.current)}</td><td className="num">{money(c.d1_30)}</td>
              <td className="num">{money(c.d31_60)}</td><td className="num">{money(c.d61_90)}</td>
              <td className="num" style={{ color: c.d90_plus ? 'var(--red)' : undefined }}>{money(c.d90_plus)}</td>
              <td className="num">{money(c.total)}</td>
            </tr>
            {open[c.contact_id] && c.invoices.map((i: any) => (
              <tr key={i.id} className="detail-row click" onClick={(e) => { e.stopPropagation(); openSource('INVOICE', i.id); }}>
                <td style={{ paddingLeft: 34 }} colSpan={4}>
                  <span className="mono small">{i.invoice_number}</span> · {fmtDate(i.date)} · due {fmtDate(i.due_date)}
                </td>
                <td className="num small muted" colSpan={1}>{i.days_overdue > 0 ? `${i.days_overdue}d overdue` : 'not due'}</td>
                <td className="num" colSpan={2}>{money(i.amount_due)}</td>
              </tr>
            ))}
          </React.Fragment>
        ))}
        <tr className="total"><td>{filtered ? 'Filtered total' : 'Total'}</td>
          <td className="num">{money(sum('current'))}</td><td className="num">{money(sum('d1_30'))}</td>
          <td className="num">{money(sum('d31_60'))}</td><td className="num">{money(sum('d61_90'))}</td>
          <td className="num">{money(sum('d90_plus'))}</td><td className="num">{money(sum('total'))}</td></tr>
      </tbody>
    </table>
  );
}

// ── Cash Flow ──────────────────────────────────────────────────────────────

function CashFlow({ d, onDrill }: { d: any; onDrill: (q: DrillQuery) => void }) {
  const { data: accounts } = useApi<any[]>('accounts.list', {});
  const idFor = (code: string) => (accounts ?? []).find((a: any) => a.code === code)?.id;
  const CRow = ({ r, neg }: { r: any; neg?: boolean }) => {
    const aid = idFor(r.code);
    const q = aid ? { title: `${r.code} ${r.name} — cash transactions`, account_id: aid, from: d.from, to: d.to, cash_only: true } : null;
    return (
      <tr className={q ? 'dbl' : ''} title={q ? 'Double-click for the cash transactions' : undefined} onDoubleClick={() => q && onDrill(q)}>
        <td style={{ paddingLeft: 32 }}>{r.code} {r.name}</td><td className="num">
        {aid
          ? <Drillable amount={neg ? -r.amount : r.amount} q={{ title: `${r.code} ${r.name} — cash transactions`, account_id: aid, from: d.from, to: d.to, cash_only: true }} onDrill={onDrill} />
          : money(neg ? -r.amount : r.amount)}
      </td></tr>
    );
  };
  return (
    <table className="tbl">
      <tbody>
        <tr><td>Opening bank balance</td><td className="num">{money(d.opening_balance)}</td></tr>
        <SectionRow label="Cash received" />
        {d.inflows.length === 0 && <tr><td className="muted" style={{ paddingLeft: 32 }}>No cash received in this period</td><td /></tr>}
        {d.inflows.map((i: any) => <CRow key={i.code} r={i} />)}
        <SectionRow label="Cash spent" />
        {d.outflows.length === 0 && <tr><td className="muted" style={{ paddingLeft: 32 }}>No cash spent in this period</td><td /></tr>}
        {d.outflows.map((o: any) => <CRow key={o.code} r={o} neg />)}
        <TotalRow label="Net cash movement" amount={d.net_movement} />
        <TotalRow label="Closing bank balance" amount={d.closing_balance} />
      </tbody>
    </table>
  );
}

// ── Tax Summary ────────────────────────────────────────────────────────────

function TaxSummary({ d, onDrill }: { d: any; onDrill: (q: DrillQuery) => void }) {
  const { data: accounts } = useApi<any[]>('accounts.list', {});
  const gst = (accounts ?? []).find((a: any) => a.system_account === 'GST');
  const gstQ = (title: string): DrillQuery => ({ title, account_id: gst?.id, from: d.from, to: d.to });
  return (
    <table className="tbl">
      <tbody>
        <tr><td>Tax on sales (collected)</td><td className="num">{gst ? <Drillable amount={d.tax_collected} q={gstQ('Sales tax — movements')} onDrill={onDrill} /> : money(d.tax_collected)}</td></tr>
        <tr><td>Tax on purchases (paid)</td><td className="num">{gst ? <Drillable amount={d.tax_paid} q={gstQ('Sales tax — movements')} onDrill={onDrill} /> : money(d.tax_paid)}</td></tr>
        <TotalRow label={d.net_tax >= 0 ? 'Net tax to pay' : 'Net tax refund'} amount={d.net_tax} />
        <tr><td>Taxable sales (net of tax)</td><td className="num">{money(d.sales.net)}</td></tr>
        <tr><td>Taxable purchases (net of tax)</td><td className="num">{money(d.purchases.net)}</td></tr>
        <SectionRow label="By tax rate" />
        {d.by_rate.map((r: any, i: number) => (
          <tr key={i} className="click" onClick={() => onDrill({ title: `${r.name} — document lines`, tax_rate_id: r.id, from: d.from, to: d.to })}>
            <td style={{ paddingLeft: 32 }}>{r.name} ({r.display_rate}%) — {r.type === 'ACCREC' ? 'sales' : r.type === 'ACCPAY' ? 'purchases' : r.type.toLowerCase()}</td>
            <td className="num">{money(r.net)} net · {money(r.tax)} tax</td></tr>
        ))}
      </tbody>
    </table>
  );
}


// ── Drill-down: the transactions behind any number ─────────────────────────

export interface DrillQuery {
  title: string;
  /** account drill */
  account_id?: number;
  from?: string;
  to?: string;
  cash_only?: boolean;
  tracking_option_id?: number;
  /** tax-rate drill */
  tax_rate_id?: number;
}

function Drillable({ amount, q, onDrill, blank }: { amount: number; q: DrillQuery; onDrill: (q: DrillQuery) => void; blank?: boolean }) {
  if (blank && !amount) return <></>;
  // A real <button>: correct semantics for "opens a panel", and href-less
  // anchors trigger a spurious navigation in some embedded environments.
  return (
    <button
      type="button"
      className="drillable"
      title="Show the transactions behind this number"
      onClick={(e) => { e.stopPropagation(); onDrill(q); }}
      onDoubleClick={(e) => { e.stopPropagation(); }}
    >
      {money(amount)}
    </button>
  );
}

function DrillModal({ q, onClose }: { q: DrillQuery; onClose: () => void }) {
  const isTax = q.tax_rate_id != null;
  const { data, error } = useApi<any>(
    isTax ? 'reports.taxRateLines' : 'reports.accountTransactions',
    isTax
      ? { tax_rate_id: q.tax_rate_id, from: q.from, to: q.to }
      : { account_id: q.account_id, from: q.from, to: q.to, cash_only: q.cash_only, tracking_option_id: q.tracking_option_id }
  );
  return (
    <Modal title={q.title} wide onClose={onClose}>
      <ErrorBanner msg={error} />
      {!data && !error && <Spinner />}
      {data && !isTax && (
        <>
          <div className="muted small" style={{ marginBottom: 10 }}>
            {data.account.code} {data.account.name}
            {q.from ? ` · ${fmtDate(q.from)} – ${fmtDate(q.to!)}` : ` · up to ${fmtDate(q.to!)}`}
            {q.cash_only ? ' · cash transactions only' : ''}
            {q.tracking_option_id ? ' · filtered by tracking' : ''}
            {' · click a row to open it'}
          </div>
          {data.lines.length === 0 ? (
            <Empty title="No transactions behind this number" />
          ) : (
            <table className="tbl">
              <thead><tr><th>Date</th><th>Journal</th><th>Document #</th><th>Source</th><th>Description</th><th>Contact</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
              <tbody>
                {data.lines.map((l: any, i: number) => (
                  <tr key={i} className="click" onClick={() => openSource(l.source_type, l.source_id)}>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(l.date)}</td>
                    <td className="mono small">{l.journal_number}</td>
                    <td className="mono small">{l.doc_number ?? ''}</td>
                    <td className="small muted">{SOURCE_LABEL[l.source_type] ?? l.source_type}</td>
                    <td>{l.description ?? l.narration}</td>
                    <td className="small">{l.contact_name ?? ''}</td>
                    <td className="num">{l.debit ? money(l.debit) : ''}</td>
                    <td className="num">{l.credit ? money(l.credit) : ''}</td>
                  </tr>
                ))}
                <tr className="total"><td colSpan={6}>Net movement</td><td className="num" colSpan={2}>{money(data.total)}</td></tr>
              </tbody>
            </table>
          )}
          {data.truncated && <p className="muted small">Showing the first {data.lines.length} transactions — narrow the date range to see the rest.</p>}
        </>
      )}
      {data && isTax && (
        <table className="tbl">
          <thead><tr><th>Date</th><th>Document</th><th>Contact</th><th>Description</th><th className="num">Net</th><th className="num">Tax</th></tr></thead>
          <tbody>
            {data.map((l: any) => (
              <tr key={l.id} className="click" onClick={() => openSource('INVOICE', l.invoice_id)}>
                <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(l.date)}</td>
                <td className="mono small">{l.invoice_number}</td>
                <td>{l.contact_name}</td>
                <td>{l.description}</td>
                <td className="num">{money(l.line_amount)}</td>
                <td className="num">{money(l.tax_amount)}</td>
              </tr>
            ))}
            {data.length === 0 && <tr><td colSpan={6}><Empty title="No document lines for this rate in the period" /></td></tr>}
          </tbody>
        </table>
      )}
      <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
        <button className="btn" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}


// ── Account Statement ──────────────────────────────────────────────────────

function Statement({ d, cols, singleAccount, groupBy }: { d: any; cols: ASCols; singleAccount: boolean; groupBy: string }) {
  if (!d.lines.length) return <Empty title="No transactions match" sub="Widen the date range or clear some filters." />;
  const showBalance = cols.balance && singleAccount && d.opening != null && !groupBy;
  // If the user has the Running balance column switched on but the conditions
  // for a meaningful running balance aren't met, say why rather than silently
  // dropping the column (that looked like a bug).
  const balanceWanted = cols.balance;
  const balanceHint = balanceWanted && !showBalance
    ? (groupBy
        ? 'Running balance is hidden while the statement is grouped — set Group by to “No grouping” to see it.'
        : !singleAccount
          ? 'Running balance needs exactly one account selected. Pick a single account in the Accounts filter above to see a true opening → running → closing balance.'
          : 'Running balance is unavailable for this selection.')
    : null;
  let running = d.opening ?? 0;
  const groupKey = (l: any): string => {
    switch (groupBy) {
      case 'account': return `${l.account_code} ${l.account_name}`;
      case 'contact': return l.contact_name ?? '(no contact)';
      case 'source': return SOURCE_LABEL[l.source_type] ?? l.source_type;
      case 'acct_type': return l.account_type;
      case 'tracking_1': return l.tracking_1 ?? '(untagged)';
      case 'tracking_2': return l.tracking_2 ?? '(untagged)';
      default: return '';
    }
  };
  const groups: Array<{ key: string; lines: any[] }> = [];
  if (groupBy) {
    const byKey = new Map<string, any[]>();
    for (const l of d.lines) {
      const k = groupKey(l);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k)!.push(l);
    }
    for (const key of [...byKey.keys()].sort((a, b) => a.localeCompare(b))) groups.push({ key, lines: byKey.get(key)! });
  } else {
    groups.push({ key: '', lines: d.lines });
  }
  const colCount = 1 + (cols.journal ? 1 : 0) + (cols.doc ? 1 : 0) + (cols.reference ? 1 : 0) + (cols.source ? 1 : 0) + (cols.account ? 1 : 0) + (cols.acct_type ? 1 : 0) + (cols.description ? 1 : 0) + (cols.contact ? 1 : 0) + (cols.tracking ? 1 : 0) + (cols.drcr ? 2 : 1) + (showBalance ? 1 : 0);
  return (
    <>
      {balanceHint && <div className="hint-bar">{balanceHint}</div>}
      <table className="tbl">
        <thead><tr>
          <th>Date</th>
          {cols.journal && <th>Journal</th>}
          {cols.doc && <th>Document #</th>}
          {cols.reference && <th>Reference</th>}
          {cols.source && <th>Source</th>}
          {cols.account && <th>Account</th>}
          {cols.acct_type && <th>Type</th>}
          {cols.description && <th>Description</th>}
          {cols.contact && <th>Contact</th>}
          {cols.tracking && <th>Tracking</th>}
          {cols.drcr ? (<><th className="num">Debit</th><th className="num">Credit</th></>) : <th className="num">Amount</th>}
          {showBalance && <th className="num">Balance</th>}
        </tr></thead>
        <tbody>
          {showBalance && (
            <tr className="section"><td colSpan={99}>Opening balance: {money(d.opening)}</td></tr>
          )}
          {groups.map((g) => (
            <React.Fragment key={g.key || '_all'}>
              {groupBy && <tr className="section"><td colSpan={colCount}>{g.key}</td></tr>}
              {g.lines.map((l: any, i: number) => {
            running += l.debit - l.credit;
            return (
              <tr key={i} className="click" title="Open transaction" onClick={() => openSource(l.source_type, l.source_id)}>
                <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(l.date)}</td>
                {cols.journal && <td className="mono small">{l.journal_number}</td>}
                {cols.doc && <td className="mono small">{l.doc_number ?? ''}</td>}
                {cols.reference && <td className="small">{l.doc_reference ?? ''}</td>}
                {cols.source && <td className="small muted">{SOURCE_LABEL[l.source_type] ?? l.source_type}</td>}
                {cols.account && <td>{l.account_code} {l.account_name}</td>}
                {cols.acct_type && <td className="small muted">{l.account_type}</td>}
                {cols.description && <td>{l.description ?? l.narration}</td>}
                {cols.contact && <td className="small">{l.contact_name ?? ''}</td>}
                {cols.tracking && <td className="small muted">{trackingOf(l)}</td>}
                {cols.drcr ? (
                  <>
                    <td className="num">{l.debit ? money(l.debit) : ''}</td>
                    <td className="num">{l.credit ? money(l.credit) : ''}</td>
                  </>
                ) : (
                  <td className="num">{money(l.debit - l.credit)}</td>
                )}
                {showBalance && <td className="num">{money(running)}</td>}
              </tr>
            );
          })}
              {groupBy && (
                <tr className="total">
                  <td colSpan={colCount - (cols.drcr ? 2 : 1)}>{g.key} subtotal</td>
                  {cols.drcr ? (
                    <>
                      <td className="num">{money(g.lines.reduce((s2: number, l: any) => s2 + l.debit, 0))}</td>
                      <td className="num">{money(g.lines.reduce((s2: number, l: any) => s2 + l.credit, 0))}</td>
                    </>
                  ) : (
                    <td className="num">{money(g.lines.reduce((s2: number, l: any) => s2 + l.debit - l.credit, 0))}</td>
                  )}
                </tr>
              )}
            </React.Fragment>
          ))}
          <tr className="total">
            <td colSpan={1 + (cols.journal ? 1 : 0) + (cols.doc ? 1 : 0) + (cols.reference ? 1 : 0) + (cols.source ? 1 : 0) + (cols.account ? 1 : 0) + (cols.acct_type ? 1 : 0) + (cols.description ? 1 : 0) + (cols.contact ? 1 : 0) + (cols.tracking ? 1 : 0)}>Statement totals</td>
            {cols.drcr ? (
              <>
                <td className="num">{money(d.total_debit)}</td>
                <td className="num">{money(d.total_credit)}</td>
              </>
            ) : (
              <td className="num">{money(d.total_debit - d.total_credit)}</td>
            )}
            {showBalance && <td className="num">{money(running)}</td>}
          </tr>
        </tbody>
      </table>
      {!singleAccount && cols.balance && (
        <div className="muted small" style={{ padding: '8px 14px' }}>Running balance appears when exactly one account is selected with no other filters.</div>
      )}
      {d.truncated && <div className="muted small" style={{ padding: '8px 14px' }}>Showing the first {d.lines.length} lines — narrow the filters to see the rest.</div>}
    </>
  );
}


// ── Aged Receivables / Payables — Detail ───────────────────────────────────

function AgedDetail({ d, search }: { d: any; search: string }) {
  const q = search.trim().toLowerCase();
  const contacts = (d.contacts ?? []).filter((c: any) => !q || c.contact_name.toLowerCase().includes(q));
  if (!contacts.length) return <Empty title="Nothing outstanding" sub={q ? 'No contacts match that search.' : undefined} />;
  const bucketIdx = (days: number) => (days <= 0 ? 0 : days <= 30 ? 1 : days <= 60 ? 2 : days <= 90 ? 3 : 4);
  const cell = (inv: any, i: number) => (bucketIdx(inv.days_overdue) === i ? money(inv.amount_due) : '');
  const t = (k: string) => contacts.reduce((s2: number, c: any) => s2 + c[k], 0);
  return (
    <table className="tbl">
      <thead><tr>
        <th>Contact / document</th><th>Date</th><th>Due date</th><th className="num">Overdue</th>
        <th className="num">Current</th><th className="num">1–30</th><th className="num">31–60</th>
        <th className="num">61–90</th><th className="num">90+</th><th className="num">Total</th>
      </tr></thead>
      <tbody>
        {contacts.map((c: any) => (
          <React.Fragment key={c.contact_id}>
            <tr className="section"><td colSpan={10}>{c.contact_name}</td></tr>
            {c.invoices.map((inv: any) => (
              <tr key={inv.id} className="click" title="Open document" onClick={() => openSource('INVOICE', inv.id)}>
                <td style={{ paddingLeft: 26 }} className="mono small">{inv.invoice_number}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(inv.date)}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(inv.due_date)}</td>
                <td className="num small muted">{inv.days_overdue > 0 ? `${inv.days_overdue}d` : ''}</td>
                <td className="num">{cell(inv, 0)}</td><td className="num">{cell(inv, 1)}</td>
                <td className="num">{cell(inv, 2)}</td><td className="num">{cell(inv, 3)}</td>
                <td className="num" style={{ color: bucketIdx(inv.days_overdue) === 4 ? 'var(--red)' : undefined }}>{cell(inv, 4)}</td>
                <td className="num">{money(inv.amount_due)}</td>
              </tr>
            ))}
            <tr className="total">
              <td colSpan={4}>{c.contact_name} subtotal</td>
              <td className="num">{money(c.current)}</td><td className="num">{money(c.d1_30)}</td>
              <td className="num">{money(c.d31_60)}</td><td className="num">{money(c.d61_90)}</td>
              <td className="num">{money(c.d90_plus)}</td><td className="num">{money(c.total)}</td>
            </tr>
          </React.Fragment>
        ))}
        <tr className="total">
          <td colSpan={4}>Total</td>
          <td className="num">{money(t('current'))}</td><td className="num">{money(t('d1_30'))}</td>
          <td className="num">{money(t('d31_60'))}</td><td className="num">{money(t('d61_90'))}</td>
          <td className="num">{money(t('d90_plus'))}</td><td className="num">{money(t('total'))}</td>
        </tr>
      </tbody>
    </table>
  );
}

function TaxReturnPanel({ from, to, net }: { from: string; to: string; net: number }) {
  const toast = useToast();
  const { data: filed, reload } = useApi<any[]>('taxreturns.list');
  const { data: prep, reload: reloadPrep } = useApi<any>('taxreturns.prepare', { from, to });
  const { data: banks } = useApi<any[]>('banking.accounts');
  const { data: gstPaid, reload: reloadPaid } = useApi<any[]>('taxreturns.gstPayments');
  const alreadyFiled = !!prep?.already_filed;

  const [payOpen, setPayOpen] = useState(false);
  const [payBank, setPayBank] = useState<number | ''>('');
  const [payAmount, setPayAmount] = useState('');
  const [payDate, setPayDate] = useState(todayIso());
  const direction = net >= 0 ? 'PAYMENT' : 'REFUND';
  useEffect(() => { if (banks?.length && !payBank) setPayBank(banks[0].id); }, [banks]);
  useEffect(() => { setPayAmount(String(Math.abs(net) / 100)); }, [net]);

  async function file() {
    if (!window.confirm(`File the tax return for ${fmtDate(from)} – ${fmtDate(to)}?\n\nThis records the figures and LOCKS the period so its transactions can no longer be changed.`)) return;
    try { await api('taxreturns.file', { from, to }); toast('Return filed — period locked'); reload(); reloadPrep(); }
    catch (e: any) { toast(e.message); }
  }
  async function unfile(id: number) {
    if (!window.confirm('Remove this filed return? The period will be unlocked so you can amend and re-file it.')) return;
    try { await api('taxreturns.unfile', id); toast('Return removed — period unlocked'); reload(); reloadPrep(); }
    catch (e: any) { toast(e.message); }
  }
  async function recordPayment() {
    try {
      await api('taxreturns.recordPayment', { date: payDate, bank_account_id: payBank, amount: toCents(payAmount || '0'), direction });
      toast(direction === 'REFUND' ? 'GST refund recorded' : 'GST payment recorded');
      setPayOpen(false); reloadPaid();
    } catch (e: any) { toast(e.message); }
  }

  return (
    <div className="card" style={{ marginTop: 16, maxWidth: 720 }}>
      <h3 style={{ marginTop: 0 }}>Tax return</h3>
      <div className="info-bar" style={{ marginBottom: 12 }}>
        Net for {fmtDate(from)} – {fmtDate(to)}: <strong>{money(Math.abs(net))} {net >= 0 ? 'to pay' : 'refund'}</strong>.
        {alreadyFiled
          ? ' This period has already been filed and is locked.'
          : ' Filing records these figures and locks the period so its transactions can’t change afterwards.'}
      </div>
      <div className="btn-row">
        {!alreadyFiled
          ? <button className="btn primary" onClick={file}>File this return &amp; lock the period</button>
          : <span className="badge green">Filed ✓</span>}
        {Math.abs(net) > 0 && (
          <button className="btn" onClick={() => setPayOpen((o) => !o)}>
            {direction === 'REFUND' ? 'Record GST refund' : 'Record GST payment'}
          </button>
        )}
      </div>

      {payOpen && (
        <div className="card tight" style={{ marginTop: 12, background: 'var(--surface-2, #f7f9fb)' }}>
          <p className="small muted" style={{ marginTop: 0 }}>
            {direction === 'REFUND'
              ? 'Record the refund received from the tax authority into your bank.'
              : 'Record paying the net GST to the tax authority from your bank.'} Date it on or after the period end.
          </p>
          <div className="form-row">
            <Field label="Bank account">
              <select value={payBank} onChange={(e) => setPayBank(Number(e.target.value))}>
                {(banks ?? []).map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </Field>
            <Field label="Amount"><input className="num" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} /></Field>
            <Field label="Date"><DateField value={payDate} onChange={setPayDate} label="payment date" /></Field>
          </div>
          <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setPayOpen(false)}>Cancel</button>
            <button className="btn primary" onClick={recordPayment}>{direction === 'REFUND' ? 'Record refund' : 'Record payment'}</button>
          </div>
        </div>
      )}

      {(filed ?? []).length > 0 && (
        <table className="tbl" style={{ marginTop: 16 }}>
          <thead><tr><th>Period</th><th className="num">Collected</th><th className="num">Paid</th><th className="num">Net</th><th>Filed</th><th /></tr></thead>
          <tbody>
            {(filed ?? []).map((r: any) => (
              <tr key={r.id}>
                <td>{fmtDate(r.period_from)} – {fmtDate(r.period_to)}</td>
                <td className="num">{money(r.collected)}</td>
                <td className="num">{money(r.paid)}</td>
                <td className="num"><strong>{money(Math.abs(r.net))} {r.net >= 0 ? 'pay' : 'refund'}</strong></td>
                <td className="muted small">{fmtDate(String(r.filed_at).slice(0, 10))}</td>
                <td style={{ textAlign: 'right' }}><button className="btn small danger" onClick={() => unfile(r.id)}>Unfile</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {(gstPaid ?? []).length > 0 && (
        <>
          <h4 style={{ margin: '18px 0 6px' }}>GST payments &amp; refunds</h4>
          <table className="tbl">
            <thead><tr><th>Date</th><th>Type</th><th>Bank</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {(gstPaid ?? []).map((p: any) => (
                <tr key={p.id}>
                  <td>{fmtDate(p.date)}</td>
                  <td>{p.direction === 'REFUND' ? 'Refund received' : 'Payment'}</td>
                  <td>{p.bank_name}</td>
                  <td className="num">{money(p.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function InventoryValuation({ d }: { d: any }) {
  const rows: any[] = d?.rows ?? [];
  if (rows.length === 0) return <Empty title="No tracked stock items yet. Mark an item as tracked (with an inventory asset account) to see it valued here." />;
  const qty = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
  return (
    <table className="tbl">
      <caption className="muted small" style={{ captionSide: 'top', textAlign: 'left', margin: '0 0 8px' }}>
        Stock on hand at weighted-average cost as at {fmtDate(d.as_at)}{d.historical ? ' (historical position)' : ''}.{d.low_count > 0 ? ` ${d.low_count} item${d.low_count === 1 ? '' : 's'} at or below reorder point.` : ''}
      </caption>
      <thead>
        <tr>
          <th>Code</th>
          <th>Item</th>
          <th className="num">Qty on hand</th>
          <th className="num">Avg cost</th>
          <th className="num">Total value</th>
          <th className="num">Reorder</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.code}>
            <td>{r.code}</td>
            <td>{r.name}{r.low && <span className="badge" style={{ marginLeft: 6, background: 'var(--danger, #c0392b)', color: '#fff' }}>low</span>}</td>
            <td className="num">{qty(r.quantity)}</td>
            <td className="num">{money(r.average_cost)}</td>
            <td className="num">{money(r.total_value)}</td>
            <td className="num muted">{r.reorder_point == null ? '—' : qty(r.reorder_point)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="total">
          <td colSpan={2}>Total</td>
          <td className="num">{qty(d.total_quantity)}</td>
          <td />
          <td className="num">{money(d.total_value)}</td>
          <td />
        </tr>
      </tfoot>
    </table>
  );
}

function ProjectPL({ d }: { d: any }) {
  const rows: any[] = d?.rows ?? [];
  if (rows.length === 0) return <Empty title="No project activity in this date range. Create a project, tag invoices and bills to it, then come back." />;
  const t = d.totals;
  const pctText = (p: number | null) => (p == null ? '—' : `${p.toFixed(1)}%`);
  return (
    <table className="tbl">
      <caption className="muted small" style={{ captionSide: 'top', textAlign: 'left', margin: '0 0 8px' }}>
        Billed revenue vs recorded cost per project for {fmtDate(d.from)} – {fmtDate(d.to)}. Revenue is sales invoices tagged to the project (net of customer credit notes); cost is bills, expense claims, supplier credits and manual costs tagged to it.
      </caption>
      <thead>
        <tr>
          <th>Project</th>
          <th>Customer</th>
          <th className="num">Revenue</th>
          <th className="num">Cost</th>
          <th className="num">Margin</th>
          <th className="num">Margin %</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.project_id}>
            <td>{r.code ? `${r.code} · ${r.name}` : r.name}</td>
            <td className="muted">{r.contact_name ?? ''}</td>
            <td className="num">{money(r.revenue)}</td>
            <td className="num">{money(r.cost)}</td>
            <td className="num" style={{ color: r.margin < 0 ? 'var(--danger, #c0392b)' : undefined }}>{money(r.margin)}</td>
            <td className="num">{pctText(r.margin_pct)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="total">
          <td>Total</td>
          <td />
          <td className="num">{money(t.revenue)}</td>
          <td className="num">{money(t.cost)}</td>
          <td className="num">{money(t.margin)}</td>
          <td className="num">{pctText(t.margin_pct)}</td>
        </tr>
      </tfoot>
    </table>
  );
}

function ProjectProfitability({ d }: { d: any }) {
  if (!d?.category) return <Empty title="Choose a tracking category to see profitability per project." />;
  const rows: any[] = d.rows ?? [];
  if (rows.length === 0) return <Empty title={`No projects in “${d.category.name}” yet. Add options to this tracking category, then tag invoices and bills to them.`} />;
  const t = d.totals;
  return (
    <table className="tbl">
      <caption className="muted small" style={{ captionSide: 'top', textAlign: 'left', margin: '0 0 8px' }}>
        Profit by {d.category.name.toLowerCase()} for {fmtDate(d.from)} – {fmtDate(d.to)}{d.basis === 'CASH' ? ', cash basis' : ''}. Income and costs are included where tagged to each option.
      </caption>
      <thead>
        <tr>
          <th>{d.category.name}</th>
          <th className="num">Income</th>
          <th className="num">Cost of sales</th>
          <th className="num">Gross profit</th>
          <th className="num">Other expenses</th>
          <th className="num">Net profit</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.option_id}>
            <td>{r.name}</td>
            <td className="num">{money(r.income)}</td>
            <td className="num">{money(r.cogs)}</td>
            <td className="num">{money(r.gross_profit)}</td>
            <td className="num">{money(r.expenses)}</td>
            <td className="num" style={{ fontWeight: 600, color: r.net < 0 ? 'var(--red, #b91c1c)' : undefined }}>{money(r.net)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="budget-subtotal">
          <td style={{ fontWeight: 600 }}>All projects</td>
          <td className="num">{money(t.income)}</td>
          <td className="num">{money(t.cogs)}</td>
          <td className="num">{money(t.gross_profit)}</td>
          <td className="num">{money(t.expenses)}</td>
          <td className="num" style={{ fontWeight: 700 }}>{money(t.net)}</td>
        </tr>
      </tfoot>
    </table>
  );
}

function CustomerStatement({ d }: { d: any }) {
  if (!d?.contact) return <Empty title="Choose a customer to produce a statement." />;
  const isOut = d.type === 'OUTSTANDING';
  return (
    <table className="tbl">
      <caption style={{ captionSide: 'top', textAlign: 'left', margin: '0 0 10px' }}>
        <div style={{ fontWeight: 700, fontSize: '1.1em' }}>{d.contact.name}</div>
        <div className="muted small">
          {d.org_name ? `Statement from ${d.org_name} · ` : ''}
          {isOut ? `Outstanding as at ${fmtDate(d.as_at)}` : `Activity ${fmtDate(d.from)} – ${fmtDate(d.to)}`}
          {d.contact.email ? ` · ${d.contact.email}` : ''}
        </div>
      </caption>
      {isOut ? (
        <>
          <thead><tr><th>Date</th><th>Due</th><th>Type</th><th>Reference</th><th className="num">Overdue (days)</th><th className="num">Amount due</th></tr></thead>
          <tbody>
            {d.lines.length === 0 && <tr><td colSpan={6} className="muted">Nothing outstanding — this customer's account is clear.</td></tr>}
            {d.lines.map((l: any) => (
              <tr key={`${l.type}-${l.id}`}>
                <td>{fmtDate(l.date)}</td>
                <td>{l.due_date ? fmtDate(l.due_date) : '—'}</td>
                <td>{l.type}</td>
                <td>{l.reference || '—'}</td>
                <td className="num">{l.days_overdue > 0 ? l.days_overdue : '—'}</td>
                <td className="num">{money(l.amount_due)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="budget-subtotal"><td colSpan={5} style={{ fontWeight: 700 }}>Total due</td><td className="num" style={{ fontWeight: 700 }}>{money(d.total)}</td></tr>
            <tr><td colSpan={6} className="muted small" style={{ paddingTop: 8 }}>
              Ageing — Current {money(d.aging.current)} · 1–30 {money(d.aging.d1_30)} · 31–60 {money(d.aging.d31_60)} · 61–90 {money(d.aging.d61_90)} · 90+ {money(d.aging.d90_plus)}
            </td></tr>
          </tfoot>
        </>
      ) : (
        <>
          <thead><tr><th>Date</th><th>Type</th><th>Reference</th><th>Details</th><th className="num">Charges</th><th className="num">Payments</th><th className="num">Balance</th></tr></thead>
          <tbody>
            <tr><td colSpan={6} style={{ fontWeight: 600 }}>Opening balance</td><td className="num" style={{ fontWeight: 600 }}>{money(d.opening_balance)}</td></tr>
            {d.lines.map((l: any, i: number) => (
              <tr key={i}>
                <td>{fmtDate(l.date)}</td>
                <td>{l.type}</td>
                <td>{l.reference || '—'}</td>
                <td className="muted">{l.description || '—'}</td>
                <td className="num">{l.debit ? money(l.debit) : ''}</td>
                <td className="num">{l.credit ? money(l.credit) : ''}</td>
                <td className="num">{money(l.balance)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="budget-subtotal"><td colSpan={6} style={{ fontWeight: 700 }}>Closing balance due</td><td className="num" style={{ fontWeight: 700 }}>{money(d.closing_balance)}</td></tr>
          </tfoot>
        </>
      )}
    </table>
  );
}

function TransactionSummary({ d }: { d: any }) {
  if (!d?.rows) return <Spinner />;
  if (d.rows.length === 0) return <Empty title="Nothing to summarise" sub="Widen the date range, or adjust the account/type filters — scope the report to the accounts you want totalled (e.g. income or expense)." />;
  const periods: any[] = d.periods ?? [];
  const multi = d.period !== 'none';
  const groupLabel = ({ account: 'Account', account_type: 'Account type', contact: 'Contact', source: 'Source', tracking_1: 'Tracking', tracking_2: 'Tracking' } as any)[d.group_by] || 'Group';
  return (
    <table className="tbl">
      <caption className="muted small" style={{ captionSide: 'top', textAlign: 'left', margin: '0 0 8px' }}>
        {fmtDate(d.from)} – {fmtDate(d.to)} · amounts in each account’s natural sign (income and expenses positive). Totals reflect the lines matching the filters above.
      </caption>
      <thead>
        <tr>
          <th>{groupLabel}</th>
          {periods.map((p) => <th key={p.key} className="num">{p.label}</th>)}
          {multi && <th className="num">Total</th>}
        </tr>
      </thead>
      <tbody>
        {d.rows.map((r: any) => (
          <tr key={r.key}>
            <td>{r.label}</td>
            {periods.map((p) => <td key={p.key} className="num">{r.cells[p.key] ? money(r.cells[p.key]) : '—'}</td>)}
            {multi && <td className="num" style={{ fontWeight: 600 }}>{money(r.total)}</td>}
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="budget-subtotal">
          <td style={{ fontWeight: 700 }}>Total</td>
          {periods.map((p) => <td key={p.key} className="num" style={{ fontWeight: 700 }}>{money(d.column_totals[p.key] || 0)}</td>)}
          {multi && <td className="num" style={{ fontWeight: 700 }}>{money(d.grand_total)}</td>}
        </tr>
      </tfoot>
    </table>
  );
}
