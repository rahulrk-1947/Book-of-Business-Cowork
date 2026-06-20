import React, { useEffect, useState } from 'react';
import { ToastProvider, useToast, useApi, ErrorBoundary, Modal, Field, ErrorBanner } from './components';
import { api, backupDb } from './api';
import { shouldShowNudge, dismissNudge, recordBackup } from './backupReminder';
import { applyLargeText } from './a11y';
import { usePlatform } from './platform';
import { QuickSearch } from './QuickSearch';
import Dashboard from './pages/Dashboard';
import Contacts from './pages/Contacts';
import Recurring from './pages/Recurring';
import Forecast from './pages/Forecast';
import FxRevalue from './pages/FxRevalue';
import Budgets from './pages/Budgets';
import ExpenseClaims from './pages/ExpenseClaims';
import PaymentReminders from './pages/PaymentReminders';
import Deferrals from './pages/Deferrals';
import Projects from './pages/Projects';
import Approvals from './pages/Approvals';
import Sales from './pages/Sales';
import Purchases from './pages/Purchases';
import Banking from './pages/Banking';
import Items from './pages/Items';
import Assets from './pages/Assets';
import Journals from './pages/Journals';
import Reports from './pages/Reports';
import FindRecode from './pages/FindRecode';
import ChartOfAccounts from './pages/ChartOfAccounts';
import Settings from './pages/Settings';
import SourceHost from './SourceHost';

export function useHash(): [string[], (h: string) => void] {
  const [hash, setHash] = useState(window.location.hash.slice(1) || 'dashboard');
  useEffect(() => {
    const h = () => setHash(window.location.hash.slice(1) || 'dashboard');
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);
  return [hash.split('/'), (h: string) => (window.location.hash = h)];
}

export function nav(h: string) {
  window.location.hash = h;
}

const NAV: Array<{ group?: string; id: string; label: string; icon: string }> = [
  { id: 'dashboard', label: 'Dashboard', icon: '◧' },
  { group: 'Business', id: 'sales', label: 'Sales', icon: '↗' },
  { id: 'purchases', label: 'Purchases', icon: '↘' },
  { id: 'expense-claims', label: 'Expense claims', icon: '🧾' },
  { id: 'payment-reminders', label: 'Payment reminders', icon: '⏰' },
  { id: 'deferrals', label: 'Accruals & deferrals', icon: '📆' },
  { id: 'projects', label: 'Projects', icon: '📁' },
  { id: 'approvals', label: 'Approvals', icon: '✓' },
  { id: 'recurring', label: 'Recurring', icon: '↻' },
  { id: 'contacts', label: 'Contacts', icon: '◉' },
  { id: 'items', label: 'Products & services', icon: '▦' },
  { group: 'Accounting', id: 'bank', label: 'Bank accounts', icon: '⌂' },
  { id: 'reports', label: 'Reports', icon: '▤' },
  { id: 'forecast', label: 'Cash flow forecast', icon: '∿' },
  { id: 'fxrevalue', label: 'Currency revaluation', icon: '⇄' },
  { id: 'budgets', label: 'Budgets', icon: '◫' },
  { id: 'recode', label: 'Find & recode', icon: '⇄' },
  { id: 'journals', label: 'Manual journals', icon: '✎' },
  { id: 'assets', label: 'Fixed assets', icon: '▣' },
  { id: 'coa', label: 'Chart of accounts', icon: '☰' },
  { group: 'Organisation', id: 'settings', label: 'Settings', icon: '⚙' },
];

export default function App() {
  const platform = usePlatform();
  const serverMode = platform.mode === 'server';
  const [nudge, setNudge] = React.useState(false);
  const [quickOpen, setQuickOpen] = React.useState(false);
  const [route] = useHash();
  const page = route[0];
  React.useEffect(() => { applyLargeText(); }, []);
  // Global keyboard shortcut: Ctrl/Cmd+K, or "/" when not typing in a field,
  // opens quick search. Esc closing is handled inside the palette.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); setQuickOpen(true); }
      else if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) { e.preventDefault(); setQuickOpen(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // Backup nudge: only for the local (this-browser) edition, where losing the
  // browser means losing data. Server data lives on the server.
  React.useEffect(() => {
    if (serverMode) return;
    api('dashboard.summary').then((d: any) => {
      const hasData = !!(d && (d.total_cash || d.receivables || d.payables || (d.recent_activity && d.recent_activity.length) || (d.drafts && d.drafts.length)));
      setNudge(shouldShowNudge(hasData));
    }).catch(() => {});
  }, [serverMode, page]);
  const { data: org } = useApi<any>('settings.getOrganisation');
  const { data: users, reload: reloadUsers } = useApi<any[]>('settings.listUsers');
  const [activeUser, setActiveUser] = React.useState<number>(1);
  const [activeUserInfo, setActiveUserInfo] = React.useState<any | null>(null);
  React.useEffect(() => {
    // Restore the last-used profile so work keeps being attributed correctly.
    let uid = 1;
    try { uid = Number(localStorage.getItem('bob-active-user') || 1) || 1; } catch { /* fine */ }
    api('settings.setActiveUser', uid)
      .then((u: any) => { setActiveUser(u.id); setActiveUserInfo(u); })
      .catch(() => { api('settings.setActiveUser', 1).then((u: any) => { setActiveUser(u.id); setActiveUserInfo(u); }).catch(() => {}); });
  }, []);
  async function switchUser(id: number) {
    const u = await api('settings.setActiveUser', id);
    setActiveUser(u.id);
    setActiveUserInfo(u);
    try { localStorage.setItem('bob-active-user', String(u.id)); } catch { /* fine */ }
    reloadUsers();
  }
  // Collapsed sidebar (Xero-style icons-only). Remembered per browser; if
  // storage is unavailable we simply start expanded.
  const [navCollapsed, setNavCollapsed] = React.useState<boolean>(() => {
    try { return localStorage.getItem('bob-nav-collapsed') === '1'; } catch { return false; }
  });
  const toggleNav = () => {
    setNavCollapsed((c) => {
      try { localStorage.setItem('bob-nav-collapsed', c ? '0' : '1'); } catch { /* fine */ }
      return !c;
    });
  };
  // Off-canvas nav drawer for narrow (mobile/tablet) screens.
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const go = (id: string) => { nav(id); setDrawerOpen(false); };
  // Close the drawer whenever we navigate to a new page.
  React.useEffect(() => { setDrawerOpen(false); }, [page]);

  const Page =
    {
      dashboard: Dashboard,
      sales: Sales,
      purchases: Purchases,
      recurring: Recurring,
      forecast: Forecast,
      fxrevalue: FxRevalue,
      budgets: Budgets,
      'expense-claims': ExpenseClaims,
      'payment-reminders': PaymentReminders,
      deferrals: Deferrals,
      projects: Projects,
      approvals: Approvals,
      contacts: Contacts,
      items: Items,
      bank: Banking,
      reports: Reports,
      recode: FindRecode,
      journals: Journals,
      assets: Assets,
      coa: ChartOfAccounts,
      settings: Settings,
    }[page] ?? Dashboard;

  return (
    <ToastProvider>
      <div className="shell">
        <a href="#main-content" className="skip-link">Skip to main content</a>
        {!serverMode && <RecurringAutoRun />}
        <aside className={`sidebar${navCollapsed ? ' collapsed' : ''}${drawerOpen ? ' drawer-open' : ''}`}>
          <div className="brand" title="Book of Business">
            <span className="logo">B</span> <span className="ni-label">Book of Business</span>
          </div>
          <nav>
            {NAV.map((n) => (
              <React.Fragment key={n.id}>
                {n.group && <div className="nav-group"><span className="ni-label">{n.group}</span></div>}
                <a className={`nav-item ${page === n.id ? 'active' : ''}`} title={n.label} onClick={() => go(n.id)}>
                  <span className="ni-icon">{n.icon}</span> <span className="ni-label">{n.label}</span>
                </a>
              </React.Fragment>
            ))}
          </nav>
          <div className="footer"><span className="ni-label">Local-first double-entry ledger.<br />All data stays on this computer.</span></div>
          <button
            type="button"
            className="nav-collapse"
            onClick={toggleNav}
            aria-label={navCollapsed ? 'Expand the menu' : 'Collapse the menu to icons'}
            title={navCollapsed ? 'Expand the menu' : 'Collapse the menu to icons'}
          >
            <span className="ni-icon">{navCollapsed ? '»' : '«'}</span> <span className="ni-label">Collapse menu</span>
          </button>
        </aside>
        {/* Tap-out overlay shown behind the drawer on small screens */}
        <div className={`nav-overlay${drawerOpen ? ' show' : ''}`} onClick={() => setDrawerOpen(false)} aria-hidden="true" />
        <div className="main">
          <header className="topbar">
            <button
              type="button"
              className="hamburger"
              onClick={() => setDrawerOpen((o) => !o)}
              aria-label="Open menu"
              aria-expanded={drawerOpen}
            >
              ☰
            </button>
            {serverMode ? (
              <select
                className="books-switch"
                title="Which organisation you're working in"
                value={platform.activeTenant?.id ?? ''}
                onChange={(e) => platform.switchTenant?.(Number(e.target.value))}
              >
                {(platform.tenants ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            ) : (
              <BooksSwitcher fallback={org?.trading_name || org?.legal_name || ''} />
            )}
            <button className="topbar-search" onClick={() => setQuickOpen(true)} title="Search everything (Ctrl/⌘+K or /)">
              <span className="ts-icon">⌕</span>
              <span className="ts-text">Search…</span>
              <span className="ts-kbd"><kbd>⌘K</kbd></span>
            </button>
            <span className="spacer" />
            <span className="muted small">{new Date().toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span>
            {serverMode ? (
              <>
                {activeUserInfo?.roles?.[0] && (
                  <span
                    className={`badge ${activeUserInfo.is_admin ? 'green' : (activeUserInfo.permissions ?? []).length <= 1 ? 'amber' : 'blue'}`}
                    style={{ marginLeft: 8 }}
                    title={`In this organisation you can: ${(activeUserInfo.permissions ?? []).join(', ') || 'view reports only'}`}
                  >
                    {activeUserInfo.roles[0]}
                  </span>
                )}
                <span className="muted small" style={{ marginLeft: 12 }}>{platform.user?.full_name || platform.user?.email}</span>
                <button className="btn small" style={{ marginLeft: 10 }} onClick={() => platform.logout?.()}>Sign out</button>
              </>
            ) : (
              <>
                <select
                  className="user-switch"
                  title="Who is working right now — everything is recorded under this name"
                  value={activeUser}
                  onChange={(e) => switchUser(Number(e.target.value))}
                >
                  {(users ?? []).filter((u: any) => u.status !== 'DISABLED').map((u: any) => (
                    <option key={u.id} value={u.id}>{u.name}</option>
                  ))}
                </select>
                {activeUserInfo?.roles?.[0] && (
                  <span
                    className={`badge ${activeUserInfo.is_admin ? 'green' : (activeUserInfo.permissions ?? []).length <= 1 ? 'amber' : 'blue'}`}
                    style={{ marginLeft: 8 }}
                    title={`This profile can: ${(activeUserInfo.permissions ?? []).join(', ') || 'view reports only'}`}
                  >
                    {activeUserInfo.roles[0]}
                  </span>
                )}
              </>
            )}
          </header>
          {activeUserInfo && !activeUserInfo.is_admin && (activeUserInfo.permissions ?? []).length <= 1 && (
            <div className="readonly-bar">
              You're working as <strong>{activeUserInfo.name}</strong> ({activeUserInfo.roles?.[0] ?? 'Read Only'}) — this profile can view everything but can't make changes. Switch profile (top right) to edit.
            </div>
          )}
          {nudge && (
            <div className="backup-bar">
              <span>💾 It's been a while since your last backup. Your books live in this browser only — back up so you can't lose them.</span>
              <span style={{ flex: 1 }} />
              <button className="btn small" onClick={async () => { const r = await backupDb(); if (r.ok) { recordBackup(); setNudge(false); } }}>Back up now</button>
              <button className="btn small ghost" onClick={() => { dismissNudge(); setNudge(false); }}>Later</button>
            </div>
          )}
          <main className="content" id="main-content" tabIndex={-1}>
            <ErrorBoundary key={page}>
              <Page route={route} />
            </ErrorBoundary>
          </main>
        </div>
        <SourceHost />
        {quickOpen && <QuickSearch onClose={() => setQuickOpen(false)} />}
      </div>
    </ToastProvider>
  );
}


/** Switch between clients' books, or start a new client. Each client is a
 *  completely separate ledger stored side by side in this browser. */
function BooksSwitcher({ fallback }: { fallback: string }) {
  const { data } = useApi<any>('books.list');
  const [naming, setNaming] = React.useState(false);
  const [name, setName] = React.useState('');
  const [err, setErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const books = data?.books ?? [];

  if (!data || books.length === 0) return <span className="org">{fallback}</span>;

  async function go(v: string) {
    setErr(null);
    if (v === '__new') { setName(''); setNaming(true); return; }
    if (v === data.active) return;
    try {
      setBusy(true);
      await api('books.switch', v);
      location.reload(); // a clean swap: the whole app reopens on the other books
    } catch (e: any) { setErr(e.message); setBusy(false); }
  }

  async function create() {
    setErr(null);
    if (!name.trim()) { setErr('Give the new client a name'); return; }
    try {
      setBusy(true);
      await api('books.create', name.trim());
      location.reload();
    } catch (e: any) { setErr(e.message); setBusy(false); }
  }

  return (
    <>
      <select
        className="books-switch"
        title="Which client's books you're working in — each client is a completely separate ledger"
        value={data.active}
        disabled={busy}
        onChange={(e) => void go(e.target.value)}
      >
        {books.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
        {data.storage_ok && <option value="__new">＋ New client books…</option>}
      </select>
      {naming && (
        <Modal title="New client books" onClose={() => setNaming(false)}>
          <ErrorBanner msg={err} />
          <p className="muted small">This starts a completely separate, empty set of books — its own contacts, chart of accounts, and reports. Your current client's books stay exactly as they are, and you can switch between them up here any time.</p>
          <Field label="Client name">
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Harbour Café Pty Ltd" onKeyDown={(e) => { if (e.key === 'Enter') void create(); }} />
          </Field>
          <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
            <button className="btn" onClick={() => setNaming(false)}>Cancel</button>
            <button className="btn primary" disabled={busy} onClick={() => void create()}>Create &amp; open</button>
          </div>
        </Modal>
      )}
    </>
  );
}


/**
 * On open, quietly generate any due recurring documents. Defaults to drafts
 * (the schedule decides whether to auto-approve), so this never posts behind
 * the user's back. Runs once per app load.
 */
function RecurringAutoRun() {
  const toast = useToast();
  React.useEffect(() => {
    let done = false;
    api('recurring.generateDue').then((r: any) => {
      if (done) return;
      if (r && r.count > 0) toast(`Created ${r.count} recurring document${r.count === 1 ? '' : 's'} — see Recurring or your drafts`);
    }).catch(() => {});
    return () => { done = true; };
  }, []);
  return null;
}
