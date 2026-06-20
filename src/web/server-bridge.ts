/**
 * Server-edition bridge. Implements the same window.bridge contract the UI
 * expects, but api() calls the hosted server's /api/rpc (carrying the session
 * cookie and the chosen organisation) instead of an in-browser database.
 * CSV/PDF are pure-browser like the single-file edition; backup downloads the
 * org's database from the server.
 */

let activeTenantId: number | null = null;
export function setActiveTenant(id: number) { activeTenantId = id; }

function download(data: BlobPart, name: string, mime: string) {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click();
  a.remove(); URL.revokeObjectURL(url);
}

async function printHtml(html: string) {
  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed'; iframe.style.right = '0'; iframe.style.bottom = '0';
  iframe.style.width = '0'; iframe.style.height = '0'; iframe.style.border = '0';
  document.body.appendChild(iframe);
  const doc = iframe.contentWindow!.document;
  doc.open(); doc.write(html); doc.close();
  await new Promise((r) => setTimeout(r, 250));
  iframe.contentWindow!.focus();
  iframe.contentWindow!.print();
  setTimeout(() => iframe.remove(), 1000);
}

export function installServerBridge() {
  (window as any).bridge = {
    api: async (path: string, ...args: unknown[]) => {
      try {
        const res = await fetch('/api/rpc', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json', 'x-tenant-id': String(activeTenantId ?? '') },
          body: JSON.stringify({ method: path, args }),
        });
        const body = await res.json();
        return body; // { ok, data } | { ok:false, error }
      } catch (e: any) {
        return { ok: false, error: e?.message ?? 'Network error — is the server reachable?' };
      }
    },
    exportPdf: async (html: string) => {
      try { await printHtml(html); return { ok: true }; }
      catch (e: any) { return { ok: false, error: e?.message ?? String(e) }; }
    },
    saveCsv: async (csv: string, name: string) => { download(csv, name, 'text/csv;charset=utf-8'); return { ok: true }; },
    backup: async () => {
      const res = await fetch(`/api/orgs/${activeTenantId}/backup`, { credentials: 'include' });
      if (!res.ok) return { ok: false, error: 'Backup failed' };
      const buf = await res.arrayBuffer();
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      download(buf, `book-of-business-backup-${stamp}.db`, 'application/octet-stream');
      return { ok: true };
    },
    restore: async () => ({ ok: false, error: 'On the hosted edition, restoring is done by an administrator from a backup file.' }),
  };
}
