/**
 * CSV import dialog used by Sales, Purchases and Manual journals.
 * Flow: pick a file → instant dry-run preview (nothing saved) → confirm →
 * documents land as DRAFTS for review and approval. Errors are listed per
 * document and never block the rows that are fine.
 */
import React, { useRef, useState } from 'react';
import { api, saveCsv } from './api';
import { useToast, Modal, ErrorBanner, Spinner } from './components';

const DOC_KINDS: Record<string, { label: string; api: 'documents' | 'journals'; type?: string }> = {
  ACCREC: { label: 'Invoices', api: 'documents', type: 'ACCREC' },
  ACCRECCREDIT: { label: 'Credit notes', api: 'documents', type: 'ACCRECCREDIT' },
  ACCPAY: { label: 'Bills', api: 'documents', type: 'ACCPAY' },
  ACCPAYCREDIT: { label: 'Supplier credits', api: 'documents', type: 'ACCPAYCREDIT' },
  JOURNAL: { label: 'Manual journals', api: 'journals' },
};

export function ImportModal({ kinds, onClose, onDone }: { kinds: string[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [kind, setKind] = useState(kinds[0]);
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<any | null>(null);
  const [result, setResult] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const k = DOC_KINDS[kind];

  async function run(text: string, dry: boolean) {
    setBusy(true);
    setErr(null);
    try {
      const r = k.api === 'journals'
        ? await api('imports.importJournals', { csv: text, dry_run: dry })
        : await api('imports.importDocuments', { type: k.type, csv: text, dry_run: dry });
      if (dry) setPreview(r);
      else {
        setResult(r);
        if (r.created.length) toast(`${r.created.length} draft${r.created.length === 1 ? '' : 's'} imported`);
        onDone();
      }
    } catch (e: any) {
      setErr(e.message);
      if (dry) setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  async function pickFile(files: FileList | null) {
    const f = files?.[0];
    if (!f) return;
    setResult(null);
    setFileName(f.name);
    const text = await f.text();
    setCsv(text);
    await run(text, true);
  }

  async function downloadTemplate() {
    const t = k.api === 'journals'
      ? await api('imports.journalTemplate')
      : await api('imports.documentTemplate', k.type);
    await saveCsv(t, `${k.label.toLowerCase().replace(/ /g, '-')}-template.csv`);
  }

  return (
    <Modal title={`Import ${k.label.toLowerCase()} from CSV`} wide onClose={onClose}>
      <ErrorBanner msg={err} />
      <div className="report-toolbar">
        {kinds.length > 1 && (
          <select value={kind} onChange={(e) => { setKind(e.target.value); setPreview(null); setResult(null); setCsv(null); setFileName(''); }} style={{ width: 170 }}>
            {kinds.map((id) => <option key={id} value={id}>{DOC_KINDS[id].label}</option>)}
          </select>
        )}
        <button className="btn" onClick={() => fileRef.current?.click()}>{csv ? 'Choose a different file' : 'Choose CSV file…'}</button>
        <input ref={fileRef} type="file" accept=".csv,text/csv" style={{ display: 'none' }} onChange={(e) => pickFile(e.target.files)} />
        {fileName && <span className="muted small">{fileName}</span>}
        <div className="grow" />
        <button className="btn" onClick={downloadTemplate}>Download template</button>
      </div>

      <p className="muted small">
        {k.api === 'journals'
          ? 'Rows sharing the same Narration and Date become one journal, and each journal must balance.'
          : 'Rows sharing the same Number become the lines of one document. New contact names are created automatically.'}
        {' '}Everything imports as <strong>drafts</strong> — review and approve before anything posts to the ledger. Names for accounts, tax rates and tracking must match this file's settings exactly (the template uses real ones).
      </p>

      {busy && <Spinner />}

      {preview && !result && (
        <>
          <div className="ok-banner">
            Ready to import <strong>{preview.created.length}</strong> of {preview.total_documents} document{preview.total_documents === 1 ? '' : 's'} as drafts
            {preview.contacts_created ? ` · ${preview.contacts_created} new contact${preview.contacts_created === 1 ? '' : 's'} will be created` : ''}
            {preview.errors.length ? ` · ${preview.errors.length} with problems (listed below, they'll be skipped)` : ''}
          </div>
          {preview.errors.length > 0 && (
            <table className="tbl" style={{ marginTop: 10 }}>
              <thead><tr><th>Document</th><th>Problem</th></tr></thead>
              <tbody>
                {preview.errors.map((e: any, i: number) => (
                  <tr key={i}><td className="mono small">{e.doc}</td><td className="small" style={{ color: 'var(--red)' }}>{e.message}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={busy || preview.created.length === 0} onClick={() => run(csv!, false)}>
              Import {preview.created.length} as drafts
            </button>
          </div>
        </>
      )}

      {result && (
        <>
          <div className="ok-banner">
            Imported <strong>{result.created.length}</strong> draft{result.created.length === 1 ? '' : 's'}
            {result.contacts_created ? ` · created ${result.contacts_created} contact${result.contacts_created === 1 ? '' : 's'}` : ''}
            {result.errors.length ? ` · ${result.errors.length} skipped` : ''}. Find them in the Drafts list to review and approve.
          </div>
          <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
            <button className="btn primary" onClick={onClose}>Done</button>
          </div>
        </>
      )}
    </Modal>
  );
}
