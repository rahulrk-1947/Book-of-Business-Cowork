/**
 * Attachments panel: upload, list, download and remove files on any
 * transaction. Files live inside the ledger database, so backups carry the
 * paperwork with them.
 */
import React, { useRef, useState } from 'react';
import { api, fmtDate } from './api';
import { useApi, useToast, ErrorBanner } from './components';

function fmtSize(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

export function Attachments({ entityType, entityId }: { entityType: string; entityId: number }) {
  const { data, reload } = useApi<any[]>('attachments.list', entityType, entityId);
  const toast = useToast();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const MAX_MB = 3;
  const ALLOWED_EXT = ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'csv', 'txt', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'ofx', 'qfx'];
  const ACCEPT = ALLOWED_EXT.map((e) => '.' + e).join(',');
  const extOf = (name: string) => (name.split('.').pop() || '').toLowerCase();

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setErr(null);
    setBusy(true);
    try {
      for (const f of [...files]) {
        if (f.size > MAX_MB * 1024 * 1024) { setErr(`"${f.name}" is over the ${MAX_MB} MB limit (it's ${(f.size / 1048576).toFixed(1)} MB)`); continue; }
        if (!ALLOWED_EXT.includes(extOf(f.name))) { setErr(`"${f.name}" isn't a supported file type. Allowed: ${ALLOWED_EXT.join(', ')}.`); continue; }
        const b64 = await new Promise<string>((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(String(r.result).split(',')[1] ?? '');
          r.onerror = () => rej(new Error(`Could not read ${f.name}`));
          r.readAsDataURL(f);
        });
        await api('attachments.add', { entity_type: entityType, entity_id: entityId, filename: f.name, mime_type: f.type || 'application/octet-stream', data_base64: b64 });
      }
      toast('File attached');
      reload();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function download(id: number) {
    try {
      const a = await api('attachments.get', id);
      const el = document.createElement('a');
      el.href = `data:${a.mime_type || 'application/octet-stream'};base64,${a.data}`;
      el.download = a.filename;
      document.body.appendChild(el);
      el.click();
      el.remove();
    } catch (e: any) { setErr(e.message); }
  }

  return (
    <div className="attachments">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h3 style={{ margin: 0 }}>Files</h3>
        <span className="muted small">{(data ?? []).length ? `${(data ?? []).length} attached` : ''}</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn small" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? 'Attaching…' : '+ Attach file'}
        </button>
        <input ref={fileRef} type="file" multiple accept={ACCEPT} style={{ display: 'none' }} onChange={(e) => upload(e.target.files)} />
      </div>
      <p className="muted small" style={{ margin: '4px 0 0' }}>
        Up to {MAX_MB} MB per file · PDF, images (PNG/JPG/GIF/WebP), CSV/TXT, Word, Excel, PowerPoint, OFX/QFX.
      </p>
      <ErrorBanner msg={err} />
      {(data ?? []).length > 0 && (
        <table className="tbl" style={{ marginTop: 8 }}>
          <tbody>
            {(data ?? []).map((a: any) => (
              <tr key={a.id}>
                <td><button type="button" className="drillable" onClick={() => download(a.id)}>{a.filename}</button></td>
                <td className="small muted">{fmtSize(a.size)}</td>
                <td className="small muted">{fmtDate(a.uploaded_at?.slice(0, 10))}</td>
                <td className="num"><a title="Remove" onClick={async () => { if (window.confirm(`Remove ${a.filename}?`)) { await api('attachments.remove', a.id); toast('File removed'); reload(); } }}>✕</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
