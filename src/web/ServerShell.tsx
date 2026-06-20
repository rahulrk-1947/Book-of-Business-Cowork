/**
 * Hosted-edition front door. Decides what to show:
 *   - not logged in            → Login / Register (or Accept-invite if the
 *                                URL is /invite/:token)
 *   - logged in, no org chosen → organisation picker (or create one)
 *   - logged in + org chosen   → the full app, talking to the server
 */
import React from 'react';
import App from '../ui/App';
import { PlatformContext, Tenant, PlatformUser } from '../ui/platform';
import { installServerBridge, setActiveTenant } from './server-bridge';

installServerBridge();

async function post(url: string, body?: any) {
  const res = await fetch(url, {
    method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}
async function get(url: string) {
  const res = await fetch(url, { credentials: 'include' });
  return res.json();
}

const inviteToken = (() => {
  const m = location.pathname.match(/^\/invite\/([^/]+)/);
  return m ? m[1] : null;
})();

export default function ServerShell() {
  const [loading, setLoading] = React.useState(true);
  const [user, setUser] = React.useState<PlatformUser | null>(null);
  const [tenants, setTenants] = React.useState<Tenant[]>([]);
  const [activeTenant, setActiveTenantState] = React.useState<Tenant | null>(null);

  async function refresh() {
    const me = await get('/api/me');
    if (me.ok) { setUser(me.data.user); setTenants(me.data.tenants); }
    else { setUser(null); setTenants([]); }
    setLoading(false);
    return me.ok ? me.data : null;
  }
  React.useEffect(() => { refresh(); }, []);

  function chooseTenant(t: Tenant) {
    setActiveTenant(t.id);
    setActiveTenantState(t);
    if (inviteToken) history.replaceState({}, '', '/'); // clean the invite URL once in
  }
  function switchTenant(id: number) {
    const t = tenants.find((x) => x.id === id);
    if (t) chooseTenant(t);
  }
  async function logout() {
    await post('/api/auth/logout');
    setUser(null); setTenants([]); setActiveTenantState(null);
    history.replaceState({}, '', '/');
  }

  if (loading) return <Centered>Loading…</Centered>;

  if (!user) return <AuthScreen inviteToken={inviteToken} onAuthed={async () => { await refresh(); }} />;

  if (inviteToken) {
    return <AcceptInvite token={inviteToken} onJoined={async () => { const d = await refresh(); const ts: Tenant[] = d?.tenants ?? []; if (ts.length) chooseTenant(ts[ts.length - 1]); }} onLogout={logout} />;
  }

  if (!activeTenant) {
    return <OrgPicker tenants={tenants} user={user} onPick={chooseTenant} onCreated={async () => { const d = await refresh(); const ts: Tenant[] = d?.tenants ?? []; if (ts.length) chooseTenant(ts[ts.length - 1]); }} onLogout={logout} />;
  }

  return (
    <PlatformContext.Provider value={{ mode: 'server', user, tenants, activeTenant, switchTenant, logout }}>
      <App key={activeTenant.id} />
    </PlatformContext.Provider>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', placeItems: 'center', height: '100vh', color: '#52606d', fontFamily: 'system-ui' }}>{children}</div>;
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#0d2538', fontFamily: 'system-ui' }}>
      <div style={{ width: 380, background: '#fff', borderRadius: 12, padding: 28, boxShadow: '0 10px 40px rgba(0,0,0,.3)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
          <span style={{ width: 30, height: 30, background: '#0078c8', color: '#fff', borderRadius: 7, display: 'grid', placeItems: 'center', fontWeight: 700 }}>B</span>
          <strong style={{ fontSize: 18 }}>Book of Business</strong>
        </div>
        <h2 style={{ margin: '0 0 14px', fontSize: 17 }}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = { width: '100%', padding: '9px 11px', border: '1px solid #cbd2d9', borderRadius: 6, marginBottom: 10, fontSize: 14, boxSizing: 'border-box' };
const btnStyle: React.CSSProperties = { width: '100%', padding: '10px', background: '#0078c8', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 600, fontSize: 14, cursor: 'pointer' };
const linkStyle: React.CSSProperties = { background: 'none', border: 'none', color: '#0078c8', cursor: 'pointer', fontSize: 13, padding: 0 };
const errStyle: React.CSSProperties = { background: '#fdecea', color: '#b71c1c', padding: '8px 11px', borderRadius: 6, fontSize: 13, marginBottom: 10 };

function AuthScreen({ inviteToken, onAuthed }: { inviteToken: string | null; onAuthed: () => void }) {
  const [mode, setMode] = React.useState<'login' | 'register'>(inviteToken ? 'register' : 'login');
  const [invite, setInvite] = React.useState<any | null>(null);
  const [email, setEmail] = React.useState('');
  const [fullName, setFullName] = React.useState('');
  const [orgName, setOrgName] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [err, setErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (inviteToken) get(`/api/invites/${inviteToken}`).then((r) => {
      if (r.ok) { setInvite(r.data); setEmail(r.data.email); }
    });
  }, []);

  async function submit() {
    setErr(null); setBusy(true);
    try {
      const r = mode === 'register'
        ? await post('/api/auth/register', { email, password, full_name: fullName || email, org_name: invite ? `${fullName || email}'s workspace` : (orgName || 'My organisation') })
        : await post('/api/auth/login', { email, password });
      if (!r.ok) { setErr(r.error); return; }
      onAuthed();
    } catch (e: any) { setErr(e?.message ?? 'Something went wrong'); }
    finally { setBusy(false); }
  }

  return (
    <Card title={mode === 'register' ? 'Create your account' : 'Sign in'}>
      {invite && <p style={{ fontSize: 13, color: '#52606d', marginTop: 0 }}>You've been invited to <strong>{invite.org_name}</strong> as <strong>{invite.role}</strong>. {mode === 'register' ? 'Create an account to accept.' : 'Sign in to accept.'}</p>}
      {err && <div style={errStyle}>{err}</div>}
      {mode === 'register' && <input style={inputStyle} placeholder="Your name" value={fullName} onChange={(e) => setFullName(e.target.value)} />}
      <input style={inputStyle} placeholder="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={!!invite} />
      {mode === 'register' && !invite && <input style={inputStyle} placeholder="Organisation name" value={orgName} onChange={(e) => setOrgName(e.target.value)} />}
      <input style={inputStyle} placeholder="Password (8+ characters)" type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
      <button style={btnStyle} disabled={busy} onClick={submit}>{busy ? 'Please wait…' : mode === 'register' ? 'Create account' : 'Sign in'}</button>
      <div style={{ textAlign: 'center', marginTop: 14 }}>
        {mode === 'login'
          ? <span style={{ fontSize: 13, color: '#52606d' }}>New here? <button style={linkStyle} onClick={() => setMode('register')}>Create an account</button></span>
          : <span style={{ fontSize: 13, color: '#52606d' }}>Already have an account? <button style={linkStyle} onClick={() => setMode('login')}>Sign in</button></span>}
      </div>
    </Card>
  );
}

function AcceptInvite({ token, onJoined, onLogout }: { token: string; onJoined: () => void; onLogout: () => void }) {
  const [invite, setInvite] = React.useState<any | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { get(`/api/invites/${token}`).then((r) => r.ok ? setInvite(r.data) : setErr('This invitation is no longer valid.')); }, []);
  async function accept() {
    setErr(null); setBusy(true);
    const r = await post(`/api/invites/${token}/accept`);
    setBusy(false);
    if (!r.ok) { setErr(r.error); return; }
    onJoined();
  }
  return (
    <Card title="Join organisation">
      {err && <div style={errStyle}>{err}</div>}
      {invite && <p style={{ fontSize: 14, color: '#3e4c59' }}>You're joining <strong>{invite.org_name}</strong> as <strong>{invite.role}</strong>.</p>}
      <button style={btnStyle} disabled={busy || !invite} onClick={accept}>{busy ? 'Joining…' : 'Accept invitation'}</button>
      <div style={{ textAlign: 'center', marginTop: 12 }}>
        <button style={linkStyle} onClick={onLogout}>Sign in as someone else</button>
      </div>
    </Card>
  );
}

function OrgPicker({ tenants, user, onPick, onCreated, onLogout }: { tenants: Tenant[]; user: PlatformUser; onPick: (t: Tenant) => void; onCreated: () => void; onLogout: () => void }) {
  const [name, setName] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  async function create() {
    if (!name.trim()) { setErr('Give the organisation a name'); return; }
    setBusy(true); setErr(null);
    const r = await post('/api/orgs', { name: name.trim() });
    setBusy(false);
    if (!r.ok) { setErr(r.error); return; }
    onCreated();
  }
  return (
    <Card title="Choose an organisation">
      {err && <div style={errStyle}>{err}</div>}
      {tenants.length > 0 ? (
        <div style={{ marginBottom: 16 }}>
          {tenants.map((t) => (
            <button key={t.id} onClick={() => onPick(t)}
              style={{ width: '100%', textAlign: 'left', padding: '11px 13px', border: '1px solid #e4e7eb', borderRadius: 7, marginBottom: 8, background: '#fff', cursor: 'pointer' }}>
              <strong>{t.name}</strong> <span style={{ color: '#7b8794', fontSize: 12 }}>· {t.role}{t.is_owner ? ' (owner)' : ''}</span>
            </button>
          ))}
        </div>
      ) : (
        <p style={{ fontSize: 13, color: '#52606d', marginTop: 0 }}>You're not in any organisation yet — create your first one.</p>
      )}
      <div style={{ borderTop: '1px solid #eef1f4', paddingTop: 14 }}>
        <input style={inputStyle} placeholder="New organisation name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') create(); }} />
        <button style={btnStyle} disabled={busy} onClick={create}>{busy ? 'Creating…' : 'Create organisation'}</button>
      </div>
      <div style={{ textAlign: 'center', marginTop: 14, fontSize: 12, color: '#7b8794' }}>
        Signed in as {user.email} · <button style={linkStyle} onClick={onLogout}>Sign out</button>
      </div>
    </Card>
  );
}
