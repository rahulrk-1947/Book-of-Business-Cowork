import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { api, money, dateError, emailError, numberError } from './api';

// ── Toast ────────────────────────────────────────────────────────────────
const ToastCtx = createContext<(msg: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const show = useCallback((m: string) => {
    setMsg(m);
    window.setTimeout(() => setMsg(null), 2800);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {msg && <div className="toast">{msg}</div>}
    </ToastCtx.Provider>
  );
}

// ── Data hook ────────────────────────────────────────────────────────────
export function useApi<T = any>(path: string, ...args: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const key = JSON.stringify(args);
  useEffect(() => {
    let live = true;
    setLoading(true);
    api<T>(path, ...args)
      .then((d) => live && (setData(d), setError(null)))
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, key, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

// ── Primitives ───────────────────────────────────────────────────────────
export function Money({ cents, currency }: { cents: number | null | undefined; currency?: string }) {
  return <span className="num">{money(cents, currency)}</span>;
}

const STATUS_COLOR: Record<string, string> = {
  DRAFT: 'grey', SUBMITTED: 'blue', AUTHORISED: 'amber', PAID: 'green', VOIDED: 'red', DELETED: 'red',
  SENT: 'blue', ACCEPTED: 'green', DECLINED: 'red', INVOICED: 'green', EXPIRED: 'grey',
  APPROVED: 'amber', BILLED: 'green', POSTED: 'green', ACTIVE: 'green', ARCHIVED: 'grey',
  REGISTERED: 'green', DISPOSED: 'grey', RECONCILED: 'green', UNRECONCILED: 'amber', INVITED: 'amber', VOID: 'red',
};
export function Badge({ status, label }: { status: string; label?: string }) {
  return <span className={`badge ${STATUS_COLOR[status] ?? 'grey'}`}>{label ?? status?.toLowerCase()}</span>;
}

export function Spinner() {
  return <span className="spin" aria-label="Loading" />;
}

export function ErrorBanner({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return <div className="error-banner">{msg}</div>;
}

export function Empty({ title, sub, actionLabel, onAction }: { title: string; sub?: string; actionLabel?: string; onAction?: () => void }) {
  return (
    <div className="empty">
      <div className="big">{title}</div>
      {sub && <div>{sub}</div>}
      {actionLabel && onAction && (
        <button className="btn primary" style={{ marginTop: 14 }} onClick={onAction}>{actionLabel}</button>
      )}
    </div>
  );
}

/** A render error in one page must never blank the whole app. */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Page crashed:', error, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="card" style={{ maxWidth: 560, margin: '40px auto' }}>
          <h2>This screen hit a problem</h2>
          <div className="error-banner">{String(this.state.error.message || this.state.error)}</div>
          <p className="muted">Your data is safe — this is a display error. Going to another screen and back usually clears it.</p>
          <div className="actions" style={{ justifyContent: 'flex-start' }}>
            <button className="btn primary" onClick={() => this.setState({ error: null })}>Try again</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export function Modal({ title, wide, onClose, children }: { title: string; wide?: boolean; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, children, grow }: { label: string; children: React.ReactNode; grow?: number }) {
  return (
    <div style={grow ? { flex: grow } : undefined}>
      <label className="field">{label}</label>
      {children}
    </div>
  );
}

export function Tabs({ tabs, active, onChange }: { tabs: { id: string; label: string }[]; active: string; onChange: (id: string) => void }) {
  return (
    <div className="tabs">
      {tabs.map((t) => (
        <div key={t.id} className={`tab ${t.id === active ? 'active' : ''}`} onClick={() => onChange(t.id)}>
          {t.label}
        </div>
      ))}
    </div>
  );
}

/** Select over an API-loaded list. */
export function PickContact({ value, onChange, filter }: { value: number | ''; onChange: (id: number) => void; filter?: 'CUSTOMERS' | 'SUPPLIERS' }) {
  const { data } = useApi<any[]>('contacts.list', { filter: filter ?? 'ALL' });
  return (
    <SearchSelect
      value={value}
      onChange={onChange}
      options={(data ?? []).map((c: any) => ({ id: c.id, label: c.name }))}
      placeholder="Choose a contact…"
    />
  );
}

export function PickProject({ value, onChange }: { value: number | null | ''; onChange: (id: number | null) => void }) {
  const { data } = useApi<any[]>('projects.listProjects');
  const open = (data ?? []).filter((p: any) => p.status !== 'ARCHIVED');
  return (
    <SearchSelect
      value={value ?? ''}
      onChange={(id) => onChange(id ? Number(id) : null)}
      options={open.map((p: any) => ({ id: p.id, label: p.code ? `${p.code} · ${p.name}` : p.name }))}
      placeholder="No project"
      allowClear
    />
  );
}

const LOCKED_TAGS = ['AR', 'AP', 'GST', 'RETAINED_EARNINGS', 'ROUNDING', 'UNREALISED_FX', 'REALISED_FX'];
export function PickAccount({ value, onChange, types, allowBank, allowSystem, anyLabel }: { value: number | ''; onChange: (id: number) => void; types?: string[]; allowBank?: boolean; allowSystem?: boolean; anyLabel?: string }) {
  const { data } = useApi<any[]>('accounts.list', {});
  // Control accounts (Accounts Receivable / Payable, Sales Tax, Retained
  // Earnings, Rounding, currency gains) are driven automatically by the engine
  // when you record a sale, bill, payment or revaluation — so they're hidden
  // from coding pickers by default. Manual journals pass allowSystem to show
  // them. The currently-selected account is always kept visible so an existing
  // line never appears blank.
  const list = (data ?? []).filter((a: any) =>
    a.status === 'ACTIVE'
    && (!types || types.includes(a.type))
    && (allowBank || !a.is_bank_account)
    && (allowSystem || !LOCKED_TAGS.includes(a.system_account) || a.id === value));
  return (
    <SearchSelect
      value={value}
      onChange={onChange}
      options={list.map((a: any) => ({ id: a.id, label: `${a.code} — ${a.name}` }))}
      placeholder={anyLabel ?? 'Account…'}
    />
  );
}

export function PickTaxRate({ value, onChange, side }: { value: number | '' | null; onChange: (id: number | null) => void; side?: 'sales' | 'purchases' }) {
  const { data } = useApi<any[]>('settings.listTaxRates');
  const list = (data ?? []).filter((t: any) => (side === 'sales' ? t.can_apply_to_sales : side === 'purchases' ? t.can_apply_to_purchases : true));
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      {list.map((t: any) => (
        <option key={t.id} value={t.id}>{t.name} ({t.display_rate}%)</option>
      ))}
    </select>
  );
}

// ── Open any transaction from anywhere ───────────────────────────────────
// Dispatches an app-wide event; SourceHost (mounted in App) renders the
// right viewer. Keeps report pages decoupled from document modals.

export function openSource(source_type: string, source_id: number) {
  window.dispatchEvent(new CustomEvent('bob:open-source', { detail: { source_type, source_id } }));
}

// ── Tracking selects (per document/journal line) ──────────────────────────

export function useTrackingCategories() {
  const { data } = useApi<any[]>('settings.listTracking');
  return (data ?? []).slice(0, 2); // Xero-style: up to two active categories
}

export function TrackingSelects({
  categories, value1, value2, onChange,
}: {
  categories: any[];
  value1: number | null;
  value2: number | null;
  onChange: (v1: number | null, v2: number | null) => void;
}) {
  if (!categories.length) return null;
  const vals = [value1, value2];
  return (
    <>
      {categories.map((c, i) => (
        <SearchSelect
          key={c.id}
          value={vals[i] ?? ''}
          onChange={(id) => {
            const v = id || null;
            onChange(i === 0 ? v : value1, i === 1 ? v : value2);
          }}
          options={c.options.map((o: any) => ({ id: o.id, label: o.name }))}
          placeholder={`${c.name}…`}
        />
      ))}
    </>
  );
}

// ── Popover: dropdown panel portalled to <body> ────────────────────────────
// Menus anchored inside the scrolling content area were getting clipped and
// painted underneath the sidebar; rendering at the document root with fixed
// positioning makes them immune to any ancestor's stacking or overflow.

export function Popover({ anchor, align = 'left', width = 240, onClose, children }: {
  anchor: HTMLElement;
  align?: 'left' | 'right';
  width?: number;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const r = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = align === 'right' ? r.right - width : r.left;
    left = Math.max(8, Math.min(left, vw - width - 8));
    let top = r.bottom + 6;
    if (top > vh - 160) top = Math.max(8, r.top - 6 - Math.min(340, vh - 16)); // open upward near the bottom
    setPos({ top, left });
    const close = () => onClose();
    // Scrolling the PAGE moves the anchor away, so dismiss — but scrolling a
    // list INSIDE the menu is normal use and must never close it.
    const onScroll = (e: Event) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
      onClose();
    };
    window.addEventListener('resize', close);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [anchor, align, width, onClose]);
  if (!pos) return null;
  return createPortal(
    <>
      <div className="popover-backdrop" onClick={onClose} />
      <div ref={menuRef} className="popover-menu" style={{ top: pos.top, left: pos.left, width }}>{children}</div>
    </>,
    document.body
  );
}

// ── SearchSelect: type-ahead picker ────────────────────────────────────────
// A combobox: shows the current choice, and typing filters every option that
// CONTAINS the words typed. Click (or Enter) to choose; the list scrolls.

export function SearchSelect({
  value, onChange, options, placeholder = 'Choose…', width = '100%', allowClear = true,
}: {
  value: number | '' | null | undefined;
  onChange: (id: number) => void;
  options: Array<{ id: number; label: string }>;
  placeholder?: string;
  /** A number fixes the field width; the default fills the surrounding column. */
  width?: number | string;
  allowClear?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const selected = options.find((o) => o.id === value);
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = words.length
    ? options.filter((o) => { const l = o.label.toLowerCase(); return words.every((w) => l.includes(w)); })
    : options;
  const pick = (id: number) => { onChange(id); setOpen(false); setQ(''); inputRef.current?.blur(); };
  return (
    <div className={`search-select${open ? ' open' : ''}`} style={{ width }}>
      <input
        ref={inputRef}
        value={open ? q : selected?.label ?? ''}
        placeholder={selected?.label ?? placeholder}
        onFocus={() => { setOpen(true); setQ(''); }}
        onChange={(e) => { setQ(e.target.value); if (!open) setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); if (shown.length) pick(shown[0].id); }
          if (e.key === 'Escape') { setOpen(false); setQ(''); inputRef.current?.blur(); }
        }}
      />
      <span className="ss-caret">▾</span>
      {open && inputRef.current && (
        <Popover
          anchor={inputRef.current}
          width={typeof width === 'number' ? Math.max(width, 250) : Math.max(250, Math.round(inputRef.current.getBoundingClientRect().width))}
          onClose={() => { setOpen(false); setQ(''); }}
        >
          <div className="multi-list">
            {allowClear && (
              <div className="ss-opt muted" onClick={() => pick(0)}>— {placeholder} —</div>
            )}
            {shown.map((o) => (
              <div key={o.id} className={`ss-opt${o.id === value ? ' sel' : ''}`} onClick={() => pick(o.id)} title={o.label}>
                {o.label}
              </div>
            ))}
            {shown.length === 0 && <span className="muted small" style={{ padding: '6px 2px' }}>Nothing contains “{q}”</span>}
          </div>
        </Popover>
      )}
    </div>
  );
}

// ── MultiPick: dropdown checklist for flexible report filters ──────────────

export function MultiPick({
  label, options, value, onChange, width = 180, searchable,
}: {
  label: string;
  options: Array<{ id: number | string; label: string; group?: string }>;
  value: Array<number | string>;
  onChange: (v: Array<number | string>) => void;
  width?: number;
  searchable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const set = new Set(value);
  const shown = q.trim()
    ? options.filter((o) => o.label.toLowerCase().includes(q.trim().toLowerCase()))
    : options;
  const toggle = (id: number | string) => {
    const next = new Set(set);
    next.has(id) ? next.delete(id) : next.add(id);
    onChange([...next]);
  };
  const summary = value.length === 0 ? `${label}: all` : value.length === 1
    ? options.find((o) => o.id === value[0])?.label ?? `${label}: 1`
    : `${label}: ${value.length} selected`;
  const btnRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={btnRef} type="button" className="filter-btn" style={{ maxWidth: width + 80 }} onClick={() => setOpen(!open)}>
        <span className="filter-btn-text">{summary}</span><span className="ss-caret-inline">▾</span>
      </button>
      {open && btnRef.current && (
        <Popover anchor={btnRef.current} width={width + 80} onClose={() => setOpen(false)}>
          {searchable && <input placeholder={`Search ${label.toLowerCase()}…`} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />}
          <div className="multi-list">
            {shown.map((o) => (
              <label key={String(o.id)} className="check">
                <input type="checkbox" checked={set.has(o.id)} onChange={() => toggle(o.id)} /> {o.label}
              </label>
            ))}
            {shown.length === 0 && <span className="muted small">No matches</span>}
          </div>
          <div style={{ display: 'flex', gap: 8, paddingTop: 4, borderTop: '1px solid var(--line)' }}>
            <button
              type="button"
              className="btn small"
              disabled={shown.length === 0}
              onClick={() => onChange([...new Set([...value, ...shown.map((o) => o.id)])])}
            >
              Select all{q.trim() ? ' shown' : ''} ({shown.length})
            </button>
            <button type="button" className="btn small" disabled={value.length === 0} onClick={() => onChange([])}>
              Clear ({value.length})
            </button>
          </div>
        </Popover>
      )}
    </>
  );
}

// ── ConfirmDanger: deliberate, multi-step destructive actions ──────────────
// Step 1: the user clicks Void/Delete and gets a plain-language summary of
// exactly what will happen. Step 2 (for ledger-affecting actions): they must
// tick an acknowledgement. Step 3: the red button — disabled until then —
// performs the action. Errors keep the dialog open instead of half-failing.

export function ConfirmDanger({
  title, lines, ack, confirmLabel, onConfirm, onClose,
}: {
  title: string;
  lines: string[];
  /** Acknowledgement text; when set, the confirm button stays disabled until ticked. */
  ack?: string;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [checked, setChecked] = useState(!ack);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal title={title} onClose={onClose}>
      <ErrorBanner msg={err} />
      <ul className="consequences">
        {lines.map((l, i) => <li key={i}>{l}</li>)}
      </ul>
      {ack && (
        <label className="check ack">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> {ack}
        </label>
      )}
      <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
        <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
        <button
          type="button"
          className="btn danger"
          disabled={!checked || busy}
          onClick={async () => {
            setErr(null);
            setBusy(true);
            try {
              await onConfirm();
              onClose();
            } catch (e: any) {
              setErr(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

// ── Paging for large lists ───────────────────────────────────────────────
// Renders one page at a time so a book with thousands of rows stays snappy —
// the cost is in painting DOM rows, not in the in-memory query. Page size is
// the operator's choice (100 is the gentle default, 1000 the ceiling).

const PAGE_SIZES = [100, 250, 500, 1000];

export function usePager<T>(rows: T[] | null | undefined, deps: unknown[] = []) {
  const all = rows ?? [];
  const [size, setSize] = useState(100);
  const [page, setPage] = useState(0);
  // Any change in the underlying filter/search resets to the first page.
  useEffect(() => { setPage(0); }, [all.length, size, ...deps]);
  const pages = Math.max(1, Math.ceil(all.length / size));
  const clamped = Math.min(page, pages - 1);
  const start = clamped * size;
  const slice = all.slice(start, start + size);
  return {
    slice,
    total: all.length,
    size, setSize,
    page: clamped, setPage,
    pages,
    from: all.length === 0 ? 0 : start + 1,
    to: Math.min(start + size, all.length),
  };
}

export function Pager({ pager, noun = 'rows' }: { pager: ReturnType<typeof usePager>; noun?: string }) {
  if (pager.total <= PAGE_SIZES[0] && pager.size === PAGE_SIZES[0]) {
    // Small list, default size — no controls needed, just a quiet count.
    return <div className="pager"><span className="muted small">{pager.total} {noun}</span></div>;
  }
  return (
    <div className="pager">
      <span className="muted small">Showing {pager.from}–{pager.to} of {pager.total} {noun}</span>
      <div className="grow" />
      <label className="muted small" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        Per page
        <select value={pager.size} onChange={(e) => pager.setSize(Number(e.target.value))} style={{ width: 84 }}>
          {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <div className="pager-nav">
        <button className="btn small" disabled={pager.page === 0} onClick={() => pager.setPage(0)} title="First page">«</button>
        <button className="btn small" disabled={pager.page === 0} onClick={() => pager.setPage(pager.page - 1)}>Prev</button>
        <span className="muted small">Page {pager.page + 1} of {pager.pages}</span>
        <button className="btn small" disabled={pager.page >= pager.pages - 1} onClick={() => pager.setPage(pager.page + 1)}>Next</button>
        <button className="btn small" disabled={pager.page >= pager.pages - 1} onClick={() => pager.setPage(pager.pages - 1)} title="Last page">»</button>
      </div>
    </div>
  );
}

// ── Document change history (audit trail) ─────────────────────────────────
// A collapsible timeline of everything that happened to a document: who did
// what, when, and — for edits and recodes — exactly what changed.

export function DocHistory({ source, docId }: { source: string; docId: number }) {
  const { data } = useApi<any>('history.forDocument', source, docId);
  const [open, setOpen] = useState(false);
  const events: any[] = data?.events ?? [];
  if (events.length === 0) return null;

  return (
    <div style={{ marginTop: 18, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
      <button className="btn small" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? '▾' : '▸'} History &amp; audit trail ({events.length})
      </button>
      {open && (
        <div style={{ marginTop: 10 }}>
          <table className="tbl">
            <thead><tr><th style={{ width: 150 }}>When</th><th style={{ width: 150 }}>Who</th><th>What</th></tr></thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td className="small" style={{ whiteSpace: 'nowrap' }}>{e.at}</td>
                  <td className="small">{e.user}</td>
                  <td className="small">
                    <strong>{e.label}</strong>
                    <ChangeDetail before={e.before} after={e.after} action={e.action} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">The earliest entry is how it was first recorded; later entries show each change since.</p>
        </div>
      )}
    </div>
  );
}

function ChangeDetail({ before, after, action }: { before: any; after: any; action: string }) {
  // Field-level diff for edits; concise summaries for everything else.
  if ((action === 'EDITED' || action === 'UPDATED' || action === 'UPDATE') && before && after) {
    const diffs = diffSnapshots(before, after);
    if (diffs.length === 0) return <span className="muted"> — lines re-saved (no field change)</span>;
    return (
      <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
        {diffs.map((d, i) => <li key={i} className="muted small">{d}</li>)}
      </ul>
    );
  }
  if (action === 'RECODE' && after) {
    const bits: string[] = [];
    if (after.account_id !== undefined) bits.push('account');
    if (after.tax_rate_id !== undefined) bits.push('tax rate');
    if (after.contact_id !== undefined) bits.push('contact');
    if (after.tracking_option_1 !== undefined || after.tracking_option_2 !== undefined) bits.push('tracking');
    return <span className="muted"> — changed {bits.join(', ') || 'coding'}</span>;
  }
  if (action === 'APPROVE' || action === 'POSTED') return <span className="muted"> — posted to the ledger</span>;
  if (action === 'COPIED_FROM' && after?.source_number) return <span className="muted"> — from {after.source_number}</span>;
  return null;
}

function fmtVal(v: any): string {
  if (v == null || v === '') return '(empty)';
  if (typeof v === 'number') return (v / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return String(v);
}

function diffSnapshots(before: any, after: any): string[] {
  const out: string[] = [];
  const labelMap: Record<string, string> = { contact: 'Contact', date: 'Date', due_date: 'Due date', reference: 'Reference', total: 'Total', total_tax: 'Tax', narration: 'Narration', auto_reversing_date: 'Auto-reversal date' };
  for (const k of Object.keys(labelMap)) {
    if (k in before || k in after) {
      const b = before[k]; const a = after[k];
      if (JSON.stringify(b) !== JSON.stringify(a)) out.push(`${labelMap[k]}: ${fmtVal(b)} → ${fmtVal(a)}`);
    }
  }
  // Line count change is the most common structural edit.
  const bl = before.lines?.length ?? 0; const al = after.lines?.length ?? 0;
  if (bl !== al) out.push(`Lines: ${bl} → ${al}`);
  return out;
}

// ── Reusable column chooser (shared across reports & list screens) ─────────
// Lets a user show/hide and persist which columns they want, so each screen
// fits how they work. Choices are remembered per screen via localStorage.

export function useColumns<T extends Record<string, boolean>>(storageKey: string, defaults: T): [T, (v: T) => void] {
  const [cols, setCols] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(`bob-cols-${storageKey}`);
      if (saved) return { ...defaults, ...JSON.parse(saved) }; // new columns inherit their default
    } catch { /* ignore */ }
    return defaults;
  });
  const set = (v: T) => {
    setCols(v);
    try { localStorage.setItem(`bob-cols-${storageKey}`, JSON.stringify(v)); } catch { /* ignore */ }
  };
  return [cols, set];
}

export function ColumnChooser({ options, value, onChange, locked = [] }: {
  options: [string, string][];
  value: Record<string, boolean>;
  onChange: (v: Record<string, boolean>) => void;
  /** Columns that must always stay on (can't be unticked) — e.g. an identifier. */
  locked?: string[];
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const shown = options.filter(([k]) => value[k]).length;
  return (
    <>
      <button ref={btnRef} type="button" className="filter-btn" onClick={() => setOpen(!open)} title="Choose which columns to show">
        <span className="filter-btn-text">Columns ({shown})</span><span className="ss-caret-inline">▾</span>
      </button>
      {open && btnRef.current && (
        <Popover anchor={btnRef.current} align="right" width={220} onClose={() => setOpen(false)}>
          {options.map(([k, label]) => {
            const isLocked = locked.includes(k);
            return (
              <label key={k} className="check" style={isLocked ? { opacity: 0.55 } : undefined}>
                <input type="checkbox" checked={!!value[k]} disabled={isLocked}
                  onChange={(e) => onChange({ ...value, [k]: e.target.checked })} /> {label}{isLocked ? ' (always shown)' : ''}
              </label>
            );
          })}
          <div style={{ display: 'flex', gap: 8, paddingTop: 6, borderTop: '1px solid var(--line)', marginTop: 4 }}>
            <button type="button" className="btn small" onClick={() => onChange(Object.fromEntries(options.map(([k]) => [k, true])))}>Show all</button>
          </div>
        </Popover>
      )}
    </>
  );
}

// ── Keyboard support for clickable table rows ─────────────────────────────
// Spread onto a <tr className="click"> to make it reachable by Tab and
// operable with Enter/Space, so the whole app is keyboard-navigable.
export function rowActivate(onActivate: () => void) {
  return {
    tabIndex: 0,
    role: 'button' as const,
    onClick: onActivate,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        // Don't hijack keys when focus is inside a control within the row.
        const tag = (e.target as HTMLElement).tagName;
        if (tag === 'INPUT' || tag === 'BUTTON' || tag === 'SELECT' || tag === 'A' || tag === 'TEXTAREA') return;
        e.preventDefault();
        onActivate();
      }
    },
  };
}


// ── Validated date input ──────────────────────────────────────────────────
// Renders a native date picker but validates the value in JS too, so an
// impossible date (e.g. 30 Feb) is flagged inline immediately rather than only
// being caught when the form is saved. Use everywhere a date is entered.
export function DateField({
  value, onChange, label = 'date', min = '1900-01-01', max = '2200-12-31', ...rest
}: {
  value: string;
  onChange: (v: string) => void;
  label?: string;
  min?: string;
  max?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'min' | 'max'>) {
  const error = dateError(value, label);
  return (
    <>
      <input
        type="date"
        min={min}
        max={max}
        value={value || ''}
        aria-invalid={!!error}
        className={error ? 'input-invalid' : undefined}
        onChange={(e) => onChange(e.target.value)}
        {...rest}
      />
      {error && <div className="field-error">{error}</div>}
    </>
  );
}

// ── Validated email input ─────────────────────────────────────────────────
// Flags an invalid email address inline as it's typed (empty is allowed).
export function EmailField({
  value, onChange, label = 'email address', ...rest
}: {
  value: string;
  onChange: (v: string) => void;
  label?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'>) {
  const error = emailError(value, label);
  return (
    <>
      <input
        type="email"
        value={value || ''}
        aria-invalid={!!error}
        className={error ? 'input-invalid' : undefined}
        onChange={(e) => onChange(e.target.value)}
        {...rest}
      />
      {error && <div className="field-error">{error}</div>}
    </>
  );
}

// ── Validated number input ────────────────────────────────────────────────
// Flags an invalid number inline as it's typed (empty allowed unless required).
export function NumberField({
  value, onChange, label = 'number', min, max, integer, allowNegative = true, required, className, ...rest
}: {
  value: string;
  onChange: (v: string) => void;
  label?: string;
  min?: number;
  max?: number;
  integer?: boolean;
  allowNegative?: boolean;
  required?: boolean;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'min' | 'max'>) {
  const error = numberError(value, { label, min, max, integer, allowNegative, required });
  const cls = [error ? 'input-invalid' : '', className || ''].filter(Boolean).join(' ') || undefined;
  return (
    <>
      <input
        type="number"
        inputMode={integer ? 'numeric' : 'decimal'}
        min={min}
        max={max}
        step={integer ? 1 : 'any'}
        value={value ?? ''}
        aria-invalid={!!error}
        className={cls}
        onChange={(e) => onChange(e.target.value)}
        {...rest}
      />
      {error && <div className="field-error">{error}</div>}
    </>
  );
}
