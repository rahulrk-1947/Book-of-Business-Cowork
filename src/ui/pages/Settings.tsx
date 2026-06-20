import React, { useState } from 'react';
import { useApi, useToast, Money, Badge, Modal, Field, Tabs, ErrorBanner, Spinner, Empty , ConfirmDanger } from '../components';
import { EmailField } from '../components';
import { DateField } from '../components';
import { api, backupDb, restoreDb, fmtDate, todayIso, fromCents, toCents } from '../api';
import { recordBackup, lastBackup, daysSinceBackup } from '../backupReminder';
import { largeTextEnabled, setLargeText } from '../a11y';
import { usePlatform } from '../platform';

export default function Settings() {
  const platform = usePlatform();
  const serverMode = platform.mode === 'server';
  const isOwnerOrAdviser = !!platform.activeTenant?.is_owner || platform.activeTenant?.role === 'Adviser';
  const [tab, setTab] = useState('org');
  return (
    <>
      <div className="page-head">
        <h1>Settings</h1>
      </div>
      <Tabs
        tabs={[
          { id: 'org', label: 'Organisation' },
          { id: 'tax', label: 'Tax rates' },
          { id: 'currency', label: 'Currencies' },
          { id: 'tracking', label: 'Tracking' },
          ...(serverMode && isOwnerOrAdviser ? [{ id: 'team', label: 'Team' }] : []),
          ...(serverMode ? [] : [{ id: 'users', label: 'Users' }]),
          { id: 'seq', label: 'Numbering' },
          { id: 'audit', label: 'Audit log' },
          { id: 'data', label: 'Backup & data' },
          { id: 'a11y', label: 'Accessibility' },
          { id: 'email', label: 'Email templates' },
          { id: 'conversion', label: 'Opening balances' },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'org' && <OrgTab />}
      {tab === 'tax' && <TaxTab />}
      {tab === 'currency' && <CurrencyTab />}
      {tab === 'tracking' && <TrackingTab />}
      {tab === 'users' && <UsersTab />}
      {tab === 'team' && <TeamTab tenantId={platform.activeTenant!.id} />}
      {tab === 'seq' && <SequencesTab />}
      {tab === 'audit' && <AuditTab />}
      {tab === 'data' && <DataTab />}
      {tab === 'a11y' && <AccessibilityTab />}
      {tab === 'email' && <EmailTemplatesTab />}
      {tab === 'conversion' && <ConversionBalancesTab />}
    </>
  );
}

// ── Organisation + locks ───────────────────────────────────────────────────

function OrgTab() {
  const { data: org, reload } = useApi<any>('settings.getOrganisation');
  const toast = useToast();
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState<any | null>(null);
  const f = form ?? org;
  if (!f) return <Spinner />;
  const set = (k: string, v: any) => setForm({ ...f, [k]: v });

  async function save() {
    try {
      setErr(null);
      await api('settings.updateOrganisation', {
        legal_name: f.legal_name, trading_name: f.trading_name, registration_number: f.registration_number,
        tax_number: f.tax_number, base_currency: f.base_currency,
        financial_year_end_month: Number(f.financial_year_end_month), financial_year_end_day: Number(f.financial_year_end_day),
        tax_basis: f.tax_basis,
      });
      toast('Organisation saved');
      setForm(null);
      reload();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  async function saveBranding() {
    try {
      setErr(null);
      await api('settings.updateOrganisation', {
        logo_data: f.logo_data ?? null,
        address_line1: f.address_line1, address_line2: f.address_line2, address_city: f.address_city,
        address_region: f.address_region, address_postcode: f.address_postcode, address_country: f.address_country,
        contact_email: f.contact_email, contact_phone: f.contact_phone, website: f.website,
        invoice_footer: f.invoice_footer,
      });
      toast('Branding saved — it’ll appear on your invoice and bill PDFs');
      setForm(null);
      reload();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  async function onLogo(file: File) {
    setErr(null);
    if (!/^image\/(png|jpeg|jpg|gif|webp|svg\+xml)$/.test(file.type)) { setErr('Logo must be a PNG, JPG, GIF, WebP or SVG image'); return; }
    if (file.size > 500 * 1024) { setErr(`Logo is ${(file.size / 1024).toFixed(0)} KB — please use one under 500 KB`); return; }
    const reader = new FileReader();
    reader.onload = () => set('logo_data', reader.result as string);
    reader.onerror = () => setErr('Could not read that image');
    reader.readAsDataURL(file);
  }

  async function saveLocks() {
    try {
      setErr(null);
      await api('settings.setLockDate', f.lock_date || null, f.adviser_lock_date || null);
      toast('Lock dates saved');
      setForm(null);
      reload();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  return (
    <div className="grid2">
      <div className="card">
        <h2>Organisation details</h2>
        <ErrorBanner msg={err} />
        <div className="form-grid">
          <Field label="Legal name"><input value={f.legal_name ?? ''} onChange={(e) => set('legal_name', e.target.value)} /></Field>
          <Field label="Trading name"><input value={f.trading_name ?? ''} onChange={(e) => set('trading_name', e.target.value)} /></Field>
          <Field label="Registration number"><input value={f.registration_number ?? ''} onChange={(e) => set('registration_number', e.target.value)} /></Field>
          <Field label="Tax number"><input value={f.tax_number ?? ''} onChange={(e) => set('tax_number', e.target.value)} /></Field>
          <Field label="Base currency">
            <input value={f.base_currency ?? 'USD'} onChange={(e) => set('base_currency', e.target.value.toUpperCase())} maxLength={3} />
          </Field>
          <Field label="Tax basis">
            <select value={f.tax_basis ?? 'ACCRUAL'} onChange={(e) => set('tax_basis', e.target.value)}>
              <option value="ACCRUAL">Accrual</option>
              <option value="CASH">Cash</option>
            </select>
          </Field>
          <Field label="Financial year ends">
            <div style={{ display: 'flex', gap: 8 }}>
              <select value={f.financial_year_end_month} onChange={(e) => set('financial_year_end_month', e.target.value)}>
                {months.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
              </select>
              <input type="number" min={1} max={31} style={{ width: 70 }} value={f.financial_year_end_day} onChange={(e) => set('financial_year_end_day', e.target.value)} />
            </div>
          </Field>
        </div>
        <div className="actions"><button className="btn primary" onClick={save}>Save organisation</button></div>
        <p className="muted small">The base currency can't change once journals exist — every posted amount is stored in it.</p>
      </div>

      <div className="card">
        <h2>Branding &amp; invoice details</h2>
        <p className="muted small">These appear on the PDFs you send. Add a logo, your address and contact details, and an optional footer (payment terms, bank details, a thank-you).</p>
        <ErrorBanner msg={err} />
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', marginBottom: 14 }}>
          <div style={{ flex: 'none', width: 120, height: 80, border: '1px dashed var(--line)', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', background: 'var(--bg)' }}>
            {f.logo_data ? <img src={f.logo_data} alt="Logo preview" style={{ maxWidth: '100%', maxHeight: '100%' }} /> : <span className="muted small">No logo</span>}
          </div>
          <div>
            <input type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml" onChange={(e) => e.target.files?.[0] && onLogo(e.target.files[0])} style={{ width: 'auto' }} />
            <div className="muted small" style={{ marginTop: 6 }}>PNG, JPG, GIF, WebP or SVG · under 500 KB.</div>
            {f.logo_data && <button className="btn small" style={{ marginTop: 8 }} onClick={() => set('logo_data', null)}>Remove logo</button>}
          </div>
        </div>
        <div className="form-grid">
          <Field label="Address line 1"><input value={f.address_line1 ?? ''} onChange={(e) => set('address_line1', e.target.value)} /></Field>
          <Field label="Address line 2"><input value={f.address_line2 ?? ''} onChange={(e) => set('address_line2', e.target.value)} /></Field>
          <Field label="City / town"><input value={f.address_city ?? ''} onChange={(e) => set('address_city', e.target.value)} /></Field>
          <Field label="Region / state"><input value={f.address_region ?? ''} onChange={(e) => set('address_region', e.target.value)} /></Field>
          <Field label="Postcode / ZIP"><input value={f.address_postcode ?? ''} onChange={(e) => set('address_postcode', e.target.value)} /></Field>
          <Field label="Country"><input value={f.address_country ?? ''} onChange={(e) => set('address_country', e.target.value)} /></Field>
          <Field label="Phone"><input value={f.contact_phone ?? ''} onChange={(e) => set('contact_phone', e.target.value)} /></Field>
          <Field label="Email"><EmailField value={f.contact_email ?? ''} onChange={(v) => set('contact_email', v)} /></Field>
          <Field label="Website"><input value={f.website ?? ''} onChange={(e) => set('website', e.target.value)} /></Field>
        </div>
        <Field label="Invoice footer (optional)">
          <textarea rows={2} value={f.invoice_footer ?? ''} onChange={(e) => set('invoice_footer', e.target.value)} placeholder="e.g. Payment due within 14 days. Bank: 00-0000-0000000-00. Thank you for your business!" />
        </Field>
        <div className="actions"><button className="btn primary" onClick={saveBranding}>Save branding</button></div>
      </div>

      <div className="card">
        <h2>Period locks</h2>
        <p className="muted small">Nothing can be posted, edited or voided on or before the lock date. Use it after filing a tax return or closing a year.</p>
        <div className="form-grid">
          <Field label="Lock date (all users)">
            <DateField value={f.lock_date ?? ''} onChange={(v) => set('lock_date', v)} label="lock date" />
          </Field>
          <Field label="Adviser lock date">
            <DateField value={f.adviser_lock_date ?? ''} onChange={(v) => set('adviser_lock_date', v)} label="lock date" />
          </Field>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => { set('lock_date', ''); }}>Clear</button>
          <button className="btn primary" onClick={saveLocks}>Save lock dates</button>
        </div>
      </div>
    </div>
  );
}

// ── Tax rates ──────────────────────────────────────────────────────────────

function TaxTab() {
  const { data, reload } = useApi<any[]>('settings.listTaxRates', true);
  const toast = useToast();
  const [editing, setEditing] = useState<any | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    try {
      setErr(null);
      await api('settings.saveTaxRate', {
        id: editing.id, name: editing.name, tax_type: editing.tax_type ?? 'NONE',
        can_apply_to_sales: !!editing.can_apply_to_sales, can_apply_to_purchases: !!editing.can_apply_to_purchases,
        components: (editing.components ?? []).filter((c: any) => c.name),
      });
      toast('Tax rate saved');
      setEditing(null);
      reload();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>Tax rates</h2>
        <div className="grow" />
        <button className="btn primary" onClick={() => setEditing({ tax_type: 'OUTPUT', can_apply_to_sales: 1, can_apply_to_purchases: 1, components: [{ name: '', percent: 0, is_compound: 0 }] })}>+ New tax rate</button>
      </div>
      <table className="tbl">
        <thead><tr><th>Name</th><th>Type</th><th className="num">Rate</th><th>Applies to</th><th>Status</th><th /></tr></thead>
        <tbody>
          {(data ?? []).map((t) => (
            <tr key={t.id}>
              <td><a onClick={() => setEditing({ ...t, components: t.components.map((c: any) => ({ ...c })) })}>{t.name}</a></td>
              <td className="muted">{t.tax_type}</td>
              <td className="num">{t.display_rate}%</td>
              <td className="muted small">{[t.can_apply_to_sales && 'Sales', t.can_apply_to_purchases && 'Purchases'].filter(Boolean).join(', ')}</td>
              <td><Badge status={t.status} /></td>
              <td className="num">{t.status === 'ACTIVE' && <a onClick={async () => { await api('settings.archiveTaxRate', t.id); reload(); }}>Archive</a>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">Editing a rate that's already on posted documents archives the old rate and creates a new one — history never changes.</p>
      {editing && (
        <Modal title={editing.id ? 'Edit tax rate' : 'New tax rate'} onClose={() => setEditing(null)}>
          <ErrorBanner msg={err} />
          <div className="form-grid">
            <Field label="Name"><input value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
            <Field label="Type">
              <select value={editing.tax_type} onChange={(e) => setEditing({ ...editing, tax_type: e.target.value })}>
                {['OUTPUT', 'INPUT', 'ZERORATED', 'EXEMPT', 'NONE', 'CAPITAL'].map((t) => <option key={t}>{t}</option>)}
              </select>
            </Field>
            <Field label="Applies to">
              <div style={{ display: 'flex', gap: 16, paddingTop: 6 }}>
                <label style={{ display: 'flex', gap: 6 }}><input type="checkbox" style={{ width: 'auto' }} checked={!!editing.can_apply_to_sales} onChange={(e) => setEditing({ ...editing, can_apply_to_sales: e.target.checked ? 1 : 0 })} /> Sales</label>
                <label style={{ display: 'flex', gap: 6 }}><input type="checkbox" style={{ width: 'auto' }} checked={!!editing.can_apply_to_purchases} onChange={(e) => setEditing({ ...editing, can_apply_to_purchases: e.target.checked ? 1 : 0 })} /> Purchases</label>
              </div>
            </Field>
          </div>
          <h3 style={{ marginTop: 14 }}>Components</h3>
          {(editing.components ?? []).map((c: any, i: number) => (
            <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
              <input placeholder="Component name" value={c.name} onChange={(e) => { const cs = [...editing.components]; cs[i] = { ...c, name: e.target.value }; setEditing({ ...editing, components: cs }); }} />
              <input type="number" step="0.001" style={{ width: 90 }} value={c.percent} onChange={(e) => { const cs = [...editing.components]; cs[i] = { ...c, percent: Number(e.target.value) }; setEditing({ ...editing, components: cs }); }} />
              <label style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 12 }}><input type="checkbox" style={{ width: 'auto' }} checked={!!c.is_compound} onChange={(e) => { const cs = [...editing.components]; cs[i] = { ...c, is_compound: e.target.checked ? 1 : 0 }; setEditing({ ...editing, components: cs }); }} /> compound</label>
              <button className="btn icon" onClick={() => setEditing({ ...editing, components: editing.components.filter((_: any, j: number) => j !== i) })}>×</button>
            </div>
          ))}
          <a onClick={() => setEditing({ ...editing, components: [...(editing.components ?? []), { name: '', percent: 0, is_compound: 0 }] })}>+ Add component</a>
          <div className="actions">
            <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
            <button className="btn primary" onClick={save}>Save</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Currencies ─────────────────────────────────────────────────────────────

function CurrencyTab() {
  const { data, reload } = useApi<any[]>('settings.listCurrencies');
  const toast = useToast();
  const [rateFor, setRateFor] = useState<any | null>(null);
  const [newCur, setNewCur] = useState<{ code: string; name: string } | null>(null);
  const [rate, setRate] = useState('');
  const [date, setDate] = useState(todayIso());

  return (
    <div className="card">
      <div className="card-head">
        <h2>Currencies & exchange rates</h2>
        <div className="grow" />
        <button className="btn primary" onClick={() => setNewCur({ code: '', name: '' })}>+ Add currency</button>
      </div>
      <table className="tbl">
        <thead><tr><th>Code</th><th>Name</th><th className="num">Latest rate (base per 1 unit)</th><th>As at</th><th /></tr></thead>
        <tbody>
          {(data ?? []).map((c) => (
            <tr key={c.code}>
              <td><b>{c.code}</b></td>
              <td>{c.name}</td>
              <td className="num">{c.latest_rate ?? '—'}</td>
              <td className="muted">{fmtDate(c.latest_rate_date)}</td>
              <td className="num"><a onClick={() => { setRateFor(c); setRate(String(c.latest_rate ?? '')); setDate(todayIso()); }}>Set rate</a></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">Rates are "base currency units per 1 foreign unit". Documents capture the rate at their date; settling at a different rate posts a realised currency gain or loss automatically.</p>

      {rateFor && (
        <Modal title={`Exchange rate — ${rateFor.code}`} onClose={() => setRateFor(null)}>
          <div className="form-grid">
            <Field label="Date"><DateField value={date} onChange={setDate} /></Field>
            <Field label={`Rate (base per 1 ${rateFor.code})`}><input type="number" step="0.0001" value={rate} onChange={(e) => setRate(e.target.value)} /></Field>
          </div>
          <div className="actions">
            <button className="btn" onClick={() => setRateFor(null)}>Cancel</button>
            <button className="btn primary" onClick={async () => { await api('settings.setExchangeRate', rateFor.code, date, Number(rate)); toast('Rate saved'); setRateFor(null); reload(); }}>Save</button>
          </div>
        </Modal>
      )}
      {newCur && (
        <Modal title="Add currency" onClose={() => setNewCur(null)}>
          <div className="form-grid">
            <Field label="ISO code"><input maxLength={3} value={newCur.code} onChange={(e) => setNewCur({ ...newCur, code: e.target.value.toUpperCase() })} placeholder="EUR" /></Field>
            <Field label="Name"><input value={newCur.name} onChange={(e) => setNewCur({ ...newCur, name: e.target.value })} placeholder="Euro" /></Field>
          </div>
          <div className="actions">
            <button className="btn" onClick={() => setNewCur(null)}>Cancel</button>
            <button className="btn primary" onClick={async () => { await api('settings.addCurrency', newCur.code, newCur.name); toast('Currency added'); setNewCur(null); reload(); }}>Add</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Users ──────────────────────────────────────────────────────────────────

function UsersTab() {
  const { data: users, reload } = useApi<any[]>('settings.listUsers');
  const { data: roles } = useApi<any[]>('settings.listRoles');
  const toast = useToast();
  const [editing, setEditing] = useState<any | null>(null);

  async function save() {
    await api('settings.saveUser', { id: editing.id, name: editing.name, email: editing.email, status: editing.status ?? 'ACTIVE', role_ids: editing.role_ids });
    toast('User saved');
    setEditing(null);
    reload();
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>Users & roles</h2>
        <div className="grow" />
        <button className="btn primary" onClick={() => setEditing({ role_ids: [2] })}>+ Invite user</button>
      </div>
      <table className="tbl">
        <thead><tr><th>Name</th><th>Email</th><th>Roles</th><th>Status</th></tr></thead>
        <tbody>
          {(users ?? []).map((u) => (
            <tr key={u.id}>
              <td><a onClick={() => setEditing({ ...u, role_ids: (roles ?? []).filter((r) => u.roles.includes(r.name)).map((r) => r.id) })}>{u.name}</a></td>
              <td className="muted">{u.email}</td>
              <td className="muted small">{u.roles.join(', ') || '—'}</td>
              <td><Badge status={u.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing && (
        <Modal title={editing.id ? 'Edit user' : 'Invite user'} onClose={() => setEditing(null)}>
          <div className="form-grid">
            <Field label="Name"><input value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
            <Field label="Email"><input value={editing.email ?? ''} onChange={(e) => setEditing({ ...editing, email: e.target.value })} /></Field>
            <Field label="Status">
              <select value={editing.status ?? 'ACTIVE'} onChange={(e) => setEditing({ ...editing, status: e.target.value })}>
                {['ACTIVE', 'INVITED', 'DISABLED'].map((s) => <option key={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="Roles">
              <div>
                {(roles ?? []).map((r) => (
                  <label key={r.id} style={{ display: 'flex', gap: 6, fontSize: 13, marginBottom: 4 }}>
                    <input type="checkbox" style={{ width: 'auto' }} checked={(editing.role_ids ?? []).includes(r.id)}
                      onChange={(e) => setEditing({ ...editing, role_ids: e.target.checked ? [...(editing.role_ids ?? []), r.id] : (editing.role_ids ?? []).filter((x: number) => x !== r.id) })} />
                    {r.name} <span className="muted small">({r.permissions.join(', ')})</span>
                  </label>
                ))}
              </div>
            </Field>
          </div>
          <div className="actions">
            <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
            <button className="btn primary" onClick={save}>Save</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Number sequences ───────────────────────────────────────────────────────

function SequencesTab() {
  const { data, reload } = useApi<any[]>('settings.listSequences');
  const toast = useToast();
  const [rows, setRows] = useState<any[] | null>(null);
  const list = rows ?? data ?? [];

  return (
    <div className="card">
      <h2>Document numbering</h2>
      <table className="tbl" style={{ maxWidth: 620 }}>
        <thead><tr><th>Document</th><th>Prefix</th><th className="num">Next number</th><th className="num">Padding</th></tr></thead>
        <tbody>
          {list.map((s, i) => (
            <tr key={s.document_type}>
              <td><b>{s.document_type}</b></td>
              <td><input style={{ width: 100 }} value={s.prefix ?? ''} onChange={(e) => { const r = [...list]; r[i] = { ...s, prefix: e.target.value }; setRows(r); }} /></td>
              <td className="num"><input type="number" style={{ width: 90 }} value={s.next_number} onChange={(e) => { const r = [...list]; r[i] = { ...s, next_number: Number(e.target.value) }; setRows(r); }} /></td>
              <td className="num"><input type="number" style={{ width: 70 }} value={s.padding} onChange={(e) => { const r = [...list]; r[i] = { ...s, padding: Number(e.target.value) }; setRows(r); }} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="actions">
        <button className="btn primary" onClick={async () => { for (const s of list) await api('settings.saveSequence', { document_type: s.document_type, prefix: s.prefix, next_number: s.next_number, padding: s.padding }); toast('Numbering saved'); setRows(null); reload(); }}>Save numbering</button>
      </div>
    </div>
  );
}

// ── Audit log ──────────────────────────────────────────────────────────────

function AuditTab() {
  const [entity, setEntity] = useState('');
  const { data } = useApi<any[]>('settings.auditLog', { entity_type: entity || undefined, limit: 200 });
  return (
    <div className="card">
      <div className="card-head">
        <h2>Audit log</h2>
        <div className="grow" />
        <select style={{ width: 200 }} value={entity} onChange={(e) => setEntity(e.target.value)}>
          <option value="">All entities</option>
          {['journal', 'invoice', 'payment', 'contact', 'account', 'bank_statement_line', 'manual_journal', 'fixed_asset', 'organisation', 'tax_rate', 'user', 'item'].map((t) => <option key={t}>{t}</option>)}
        </select>
      </div>
      <table className="tbl">
        <thead><tr><th>When</th><th>Who</th><th>Entity</th><th>Action</th><th>Detail</th></tr></thead>
        <tbody>
          {(data ?? []).map((a) => (
            <tr key={a.id}>
              <td className="muted small" style={{ whiteSpace: 'nowrap' }}>{a.created_at}</td>
              <td>{a.user_name ?? '—'}</td>
              <td className="muted">{a.entity_type} #{a.entity_id}</td>
              <td><Badge status={a.action} /></td>
              <td className="muted small" style={{ maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.after_json ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Backup & data ──────────────────────────────────────────────────────────

function DataTab() {
  const toast = useToast();
  const [integrity, setIntegrity] = useState<any | null>(null);
  const [lastBkp, setLastBkp] = useState<Date | null>(lastBackup());
  const { data: books } = useApi<any>('books.list');
  const { data: about } = useApi<any>('settings.about');
  const [deleting, setDeleting] = useState(false);
  const activeBook = books?.books?.find((b: any) => b.id === books.active);
  return (
    <div className="grid2">
      <div className="card">
        <h2>Backup & restore</h2>
        <p className="muted">Your entire ledger is one SQLite file on this computer. Back it up anywhere; restore replaces all current data.</p>
        <div className="actions" style={{ justifyContent: 'flex-start' }}>
          <button className="btn primary" onClick={async () => { const r = await backupDb(); if (r.ok) { recordBackup(); setLastBkp(new Date()); toast('Backup saved'); } }}>Back up now…</button>
          <button className="btn" onClick={async () => { const r = await restoreDb(); if (!r.ok && r.error !== 'cancelled') toast(r.error!); }}>Restore from backup…</button>
        </div>
        <p className="muted small" style={{ marginTop: 10 }}>
          {lastBkp
            ? `Last backed up ${daysSinceBackup() === 0 ? 'today' : `${daysSinceBackup()} day(s) ago`} (${fmtDate(lastBkp.toISOString().slice(0, 10))}).`
            : 'You haven’t backed up from this browser yet. A backup is the only way to recover your data if this browser is cleared.'}
        </p>
      </div>
      {books && books.books.length > 1 && (
        <div className="card">
          <h2>Remove these books</h2>
          <p className="muted">
            Deletes <strong>{activeBook?.name}</strong> from this browser entirely — every transaction, contact and report in
            this client's ledger. Other clients' books are untouched. Back up first if there's any chance you'll want them again.
          </p>
          <div className="actions" style={{ justifyContent: 'flex-start' }}>
            <button className="btn danger" onClick={() => setDeleting(true)}>Delete these books…</button>
          </div>
          {deleting && (
            <ConfirmDanger
              title={`Delete the books for ${activeBook?.name}?`}
              lines={[
                'This permanently removes this entire ledger from this browser.',
                'A downloaded backup is the only way back.',
                'Other clients in the switcher are not affected.',
              ]}
              ack="I understand this deletes all of this client's data"
              confirmLabel="Delete these books"
              onClose={() => setDeleting(false)}
              onConfirm={async () => {
                const r = await (window as any).bridge.api('books.delete', books.active);
                if (!r.ok) { toast(r.error); setDeleting(false); return; }
                location.reload();
              }}
            />
          )}
        </div>
      )}
      <div className="card">
        <h2>Ledger integrity</h2>
        <p className="muted">Verifies that every posted journal balances to the cent — the core double-entry invariant.</p>
        <div className="actions" style={{ justifyContent: 'flex-start' }}>
          <button className="btn" onClick={async () => setIntegrity(await api('settings.checkIntegrity'))}>Run integrity check</button>
        </div>
        {integrity && (
          <div className={integrity.ok ? 'ok-banner' : 'error-banner'} style={{ marginTop: 10 }}>{integrity.message}</div>
        )}
      </div>

      <div className="card">
        <h2>About &amp; data format</h2>
        <p className="muted">The data format updates automatically when you open your books in a newer version of the app. A safety backup of your file is taken before any upgrade, and a file from a newer version won’t be opened by an older app.</p>
        {about && (
          <div className="muted small" style={{ marginTop: 6 }}>
            Data format: <strong>v{about.schema_version}</strong>{' '}
            {about.up_to_date
              ? '(up to date)'
              : about.newer_than_app
                ? '(created by a newer version of the app — please update)'
                : `(will upgrade to v${about.app_schema_version} on next open)`}
          </div>
        )}
      </div>
    </div>
  );
}


// ── Tracking categories ────────────────────────────────────────────────────

function TrackingTab() {
  const { data, reload } = useApi<any[]>('settings.listTracking');
  const toast = useToast();
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ name: string; options: string } | null>(null);
  const [renaming, setRenaming] = useState<any | null>(null);
  const [newOption, setNewOption] = useState<Record<number, string>>({});
  const cats = data ?? [];

  async function createCategory() {
    setErr(null);
    if (cats.length >= 2) return setErr('Up to two active tracking categories are supported — archive one first.');
    const options = (creating!.options ?? '').split(',').map((o) => o.trim()).filter(Boolean).map((name) => ({ name }));
    if (!creating!.name.trim()) return setErr('Give the category a name (e.g. Region, Department, Project)');
    if (!options.length) return setErr('Add at least one option, separated by commas');
    try {
      await api('settings.saveTrackingCategory', { name: creating!.name.trim(), options });
      toast('Tracking category created');
      setCreating(null);
      reload();
    } catch (e: any) { setErr(e.message); }
  }

  async function addOption(cat: any) {
    const name = (newOption[cat.id] ?? '').trim();
    if (!name) return;
    try {
      await api('settings.saveTrackingCategory', { id: cat.id, name: cat.name, options: [{ name }] });
      setNewOption({ ...newOption, [cat.id]: '' });
      toast('Option added');
      reload();
    } catch (e: any) { setErr(e.message); }
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>Tracking categories</h2>
        <div className="grow" />
        <button className="btn primary" onClick={() => setCreating({ name: '', options: '' })}>+ New category</button>
      </div>
      <p className="muted small">Tag document and journal lines with up to two categories — Region, Department, Project — then filter the Profit &amp; Loss by any option to see that slice of the business. Tags travel onto the ledger when documents are approved, so the filtered numbers always drill down to real transactions.</p>
      <ErrorBanner msg={err} />
      {cats.length === 0 && <Empty title="No tracking categories yet" sub="Create one — for example 'Region' with options North and South." />}
      <div className="grid2">
        {cats.map((c: any) => (
          <div key={c.id} className="card" style={{ margin: 0 }}>
            <div className="card-head">
              <h3 style={{ margin: 0 }}>{c.name}</h3>
              <div className="grow" />
              <a onClick={() => setRenaming({ ...c })}>Rename</a>
              <a style={{ marginLeft: 12 }} onClick={async () => {
                if (!window.confirm(`Archive "${c.name}"? Existing transactions keep their tags; new ones won't offer it.`)) return;
                await api('settings.archiveTrackingCategory', c.id); toast('Category archived'); reload();
              }}>Archive</a>
            </div>
            <table className="tbl">
              <tbody>
                {c.options.map((o: any) => (
                  <tr key={o.id}>
                    <td>{o.name}</td>
                    <td className="num"><a onClick={async () => { await api('settings.archiveTrackingOption', o.id); toast('Option archived'); reload(); }}>Archive</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <input placeholder="New option…" value={newOption[c.id] ?? ''} onChange={(e) => setNewOption({ ...newOption, [c.id]: e.target.value })}
                onKeyDown={(e) => e.key === 'Enter' && addOption(c)} />
              <button className="btn" onClick={() => addOption(c)}>Add</button>
            </div>
          </div>
        ))}
      </div>

      {creating && (
        <Modal title="New tracking category" onClose={() => setCreating(null)}>
          <div className="form-grid">
            <Field label="Category name"><input autoFocus placeholder="Region" value={creating.name} onChange={(e) => setCreating({ ...creating, name: e.target.value })} /></Field>
            <Field label="Options (comma separated)"><input placeholder="North, South, East" value={creating.options} onChange={(e) => setCreating({ ...creating, options: e.target.value })} /></Field>
          </div>
          <div className="actions">
            <button className="btn" onClick={() => setCreating(null)}>Cancel</button>
            <button className="btn primary" onClick={createCategory}>Create</button>
          </div>
        </Modal>
      )}
      {renaming && (
        <Modal title="Rename category" onClose={() => setRenaming(null)}>
          <div className="form-grid">
            <Field label="Name"><input value={renaming.name} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} /></Field>
          </div>
          <div className="actions">
            <button className="btn" onClick={() => setRenaming(null)}>Cancel</button>
            <button className="btn primary" onClick={async () => { await api('settings.saveTrackingCategory', { id: renaming.id, name: renaming.name, options: [] }); toast('Renamed'); setRenaming(null); reload(); }}>Save</button>
          </div>
        </Modal>
      )}
    </div>
  );
}


// ── Team (hosted edition: invite teammates, manage roles) ───────────────────

const TEAM_ROLES = ['Adviser', 'Standard', 'Read Only', 'Invoice Only'];

function TeamTab({ tenantId }: { tenantId: number }) {
  const toast = useToast();
  const [members, setMembers] = useState<any[]>([]);
  const [invites, setInvites] = useState<any[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('Standard');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const m = await fetch(`/api/orgs/${tenantId}/members`, { credentials: 'include' }).then((r) => r.json());
    const i = await fetch(`/api/orgs/${tenantId}/invites`, { credentials: 'include' }).then((r) => r.json());
    if (m.ok) setMembers(m.data);
    if (i.ok) setInvites(i.data);
  }
  React.useEffect(() => { load(); }, [tenantId]);

  async function invite() {
    setErr(null);
    if (!email.trim()) { setErr('Enter an email address'); return; }
    setBusy(true);
    const r = await fetch(`/api/orgs/${tenantId}/invites`, {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), role }),
    }).then((x) => x.json());
    setBusy(false);
    if (!r.ok) { setErr(r.error); return; }
    setEmail('');
    toast('Invitation created — share the link');
    load();
  }
  async function changeRole(userId: number, newRole: string) {
    const r = await fetch(`/api/orgs/${tenantId}/members/${userId}`, {
      method: 'PUT', credentials: 'include', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: newRole }),
    }).then((x) => x.json());
    if (!r.ok) { toast(r.error); return; }
    toast('Role updated'); load();
  }
  async function removeMember(userId: number) {
    if (!window.confirm('Remove this person from the organisation?')) return;
    const r = await fetch(`/api/orgs/${tenantId}/members/${userId}`, { method: 'DELETE', credentials: 'include' }).then((x) => x.json());
    if (!r.ok) { toast(r.error); return; }
    toast('Removed'); load();
  }
  async function revoke(inviteId: number) {
    await fetch(`/api/orgs/${tenantId}/invites/${inviteId}`, { method: 'DELETE', credentials: 'include' });
    load();
  }
  function copyLink(link: string) {
    navigator.clipboard?.writeText(link).then(() => toast('Invite link copied'), () => toast(link));
  }

  return (
    <>
      <div className="card">
        <h2>Invite a teammate</h2>
        <ErrorBanner msg={err} />
        <p className="muted small" style={{ marginTop: 0 }}>They'll get a link to join this organisation with the role you choose. Roles are enforced — a Read-Only teammate can view everything but can't make changes.</p>
        <div className="report-toolbar">
          <input placeholder="teammate@email.com" value={email} onChange={(e) => setEmail(e.target.value)} style={{ width: 240 }} />
          <select value={role} onChange={(e) => setRole(e.target.value)} style={{ width: 150 }}>
            {TEAM_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <button className="btn primary" disabled={busy} onClick={invite}>Create invite</button>
        </div>
        {invites.length > 0 && (
          <table className="tbl" style={{ marginTop: 12 }}>
            <thead><tr><th>Pending invite</th><th>Role</th><th>Link</th><th /></tr></thead>
            <tbody>
              {invites.map((i) => (
                <tr key={i.id}>
                  <td>{i.email}</td>
                  <td>{i.role}</td>
                  <td><button className="btn small" onClick={() => copyLink(i.link)}>Copy link</button></td>
                  <td style={{ textAlign: 'right' }}><button className="btn small danger" onClick={() => revoke(i.id)}>Revoke</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Members</h2>
        <table className="tbl">
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th /></tr></thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id}>
                <td><strong>{m.full_name}</strong></td>
                <td>{m.email}</td>
                <td>
                  {m.is_owner
                    ? <Badge status="ACTIVE" label="Owner" />
                    : (
                      <select value={m.role} onChange={(e) => changeRole(m.id, e.target.value)} style={{ width: 150 }}>
                        {TEAM_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                    )}
                </td>
                <td style={{ textAlign: 'right' }}>
                  {!m.is_owner && <button className="btn small danger" onClick={() => removeMember(m.id)}>Remove</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}


function AccessibilityTab() {
  const [largeText, setLT] = useState(largeTextEnabled());
  return (
    <div className="card" style={{ maxWidth: 640 }}>
      <h2>Accessibility</h2>
      <p className="muted">Adjust how the app looks and reads. These settings are remembered on this device.</p>
      <label className="check" style={{ marginTop: 12 }}>
        <input type="checkbox" checked={largeText} onChange={(e) => { setLT(e.target.checked); setLargeText(e.target.checked); }} />
        <span><strong>Larger text</strong><br /><span className="muted small">Increases text size across the app for easier reading.</span></span>
      </label>
      <p className="muted small" style={{ marginTop: 16 }}>
        The app also follows your system settings for reduced motion, and every screen can be navigated with the keyboard
        (<kbd>Tab</kbd> to move, <kbd>Enter</kbd> to open, <kbd>Esc</kbd> to close). Press <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>K</kbd> or <kbd>/</kbd> to search from anywhere.
      </p>
    </div>
  );
}


function EmailTemplatesTab() {
  const { data: templates, reload } = useApi<any[]>('email.listTemplates');
  const toast = useToast();
  const [sel, setSel] = useState<string>('ACCREC');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [loaded, setLoaded] = useState<string | null>(null);

  const current = (templates ?? []).find((t: any) => t.doc_type === sel);
  React.useEffect(() => {
    if (current && loaded !== sel) { setSubject(current.subject); setBody(current.body); setLoaded(sel); }
  }, [current, sel, loaded]);

  async function save() {
    try { await api('email.saveTemplate', { doc_type: sel, subject, body }); toast('Template saved'); reload(); }
    catch (e: any) { toast(e.message); }
  }
  async function reset() {
    try { const t: any = await api('email.resetTemplate', sel); setSubject(t.subject); setBody(t.body); toast('Reset to default'); reload(); }
    catch (e: any) { toast(e.message); }
  }

  return (
    <div className="card" style={{ maxWidth: 720 }}>
      <h2>Email templates</h2>
      <p className="muted small">The subject and message used when you email a document. Use placeholders and they’ll be filled in automatically.</p>
      <Field label="Document type">
        <select value={sel} onChange={(e) => { setSel(e.target.value); setLoaded(null); }}>
          {(templates ?? []).map((t: any) => <option key={t.doc_type} value={t.doc_type}>{t.label}{t.is_default ? ' (default)' : ''}</option>)}
        </select>
      </Field>
      <Field label="Subject"><input value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>
      <Field label="Message"><textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
      <p className="muted small">Placeholders: <code>{'{contact}'}</code> <code>{'{number}'}</code> <code>{'{total}'}</code> <code>{'{amount_due}'}</code> <code>{'{due_date}'}</code> <code>{'{date}'}</code> <code>{'{currency}'}</code> <code>{'{reference}'}</code> <code>{'{org}'}</code> <code>{'{footer}'}</code></p>
      <div className="btn-row">
        <button className="btn primary" onClick={save}>Save template</button>
        <button className="btn" onClick={reset}>Reset to default</button>
      </div>
    </div>
  );
}


function ConversionBalancesTab() {
  const { data: existing, reload } = useApi<any>('conversions.get');
  const { data: accounts } = useApi<any[]>('accounts.list', {});
  const toast = useToast();
  const [date, setDate] = useState('');
  const [vals, setVals] = useState<Record<number, { debit: string; credit: string }>>({});
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  React.useEffect(() => {
    if (!existing || loaded) return;
    setDate(existing.conversion_date ?? todayIso());
    const v: Record<number, { debit: string; credit: string }> = {};
    for (const l of existing.lines) v[l.account_id] = { debit: l.debit ? fromCents(l.debit) : '', credit: l.credit ? fromCents(l.credit) : '' };
    setVals(v);
    setLoaded(true);
  }, [existing, loaded]);

  const active = (accounts ?? []).filter((a: any) => a.status === 'ACTIVE');
  const cell = (id: number, side: 'debit' | 'credit') => vals[id]?.[side] ?? '';
  function setCell(id: number, side: 'debit' | 'credit', val: string) {
    setVals((v) => ({ ...v, [id]: { debit: side === 'debit' ? val : (v[id]?.debit ?? ''), credit: side === 'credit' ? val : (v[id]?.credit ?? '') } }));
  }
  const totDr = active.reduce((s: number, a: any) => s + (parseFloat(cell(a.id, 'debit') || '0') || 0), 0);
  const totCr = active.reduce((s: number, a: any) => s + (parseFloat(cell(a.id, 'credit') || '0') || 0), 0);
  const diff = Math.round((totDr - totCr) * 100) / 100;

  async function save() {
    setErr(null);
    const lines = active
      .map((a: any) => ({ account_id: a.id, debit: toCents(cell(a.id, 'debit') || '0'), credit: toCents(cell(a.id, 'credit') || '0') }))
      .filter((l: any) => l.debit !== 0 || l.credit !== 0);
    try { await api('conversions.save', { conversion_date: date, lines }); toast('Opening balances saved'); setLoaded(false); reload(); }
    catch (e: any) { setErr(e.message); }
  }
  async function clearAll() {
    if (!window.confirm('Remove all opening balances? This reverses the opening journal.')) return;
    try { await api('conversions.clear'); toast('Opening balances cleared'); setVals({}); setLoaded(false); reload(); }
    catch (e: any) { setErr(e.message); }
  }

  return (
    <div className="card" style={{ maxWidth: 820 }}>
      <h2>Opening balances</h2>
      <p className="muted small">
        Migrating from another system? Enter your trial balance as at the day before you start (your conversion date).
        These post as one opening journal. If the figures don’t quite balance, the difference is parked in
        <strong> Historical Adjustment</strong> so you can start now and tidy it later.
      </p>
      <Field label="Conversion date"><DateField value={date} onChange={setDate} label="conversion date" /></Field>

      <div className="card tight" style={{ marginTop: 12 }}>
        <table className="tbl">
          <thead><tr><th>Account</th><th className="num" style={{ width: 140 }}>Debit</th><th className="num" style={{ width: 140 }}>Credit</th></tr></thead>
          <tbody>
            {active.map((a: any) => (
              <tr key={a.id}>
                <td>{a.code} {a.name}</td>
                <td><input className="num" value={cell(a.id, 'debit')} placeholder="0" onChange={(e) => setCell(a.id, 'debit', e.target.value)} /></td>
                <td><input className="num" value={cell(a.id, 'credit')} placeholder="0" onChange={(e) => setCell(a.id, 'credit', e.target.value)} /></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="budget-subtotal">
              <td style={{ textAlign: 'right' }}>Totals</td>
              <td className="num">{totDr.toFixed(2)}</td>
              <td className="num">{totCr.toFixed(2)}</td>
            </tr>
            <tr>
              <td style={{ textAlign: 'right' }} className="muted small">Difference (to Historical Adjustment)</td>
              <td className="num" colSpan={2} style={{ color: diff === 0 ? 'var(--green)' : 'var(--amber, #b45309)', fontWeight: 600 }}>
                {diff === 0 ? 'Balanced ✓' : `${diff > 0 ? 'Dr' : 'Cr'} ${Math.abs(diff).toFixed(2)}`}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <ErrorBanner msg={err} />
      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="btn primary" onClick={save}>Save opening balances</button>
        {existing?.posted && <button className="btn danger" onClick={clearAll}>Clear all</button>}
      </div>
    </div>
  );
}
