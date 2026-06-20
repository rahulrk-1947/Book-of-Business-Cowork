/**
 * Browser edition of the Electron bridge. Same window.bridge contract the UI
 * already speaks, but everything happens in this page:
 *   api      → calls the service registry directly
 *   persist  → the whole SQLite file is saved to IndexedDB after every call
 *   exportPdf→ renders into a hidden iframe and opens the print dialog
 *   saveCsv  → triggers a file download
 *   backup   → downloads the .db file;  restore → upload a .db file
 */
import { setDb, runMigrations } from '../backend/db';
import { call } from '../backend/registry';
import { seedDemo } from '../backend/seed/demo';
import { seedClientSample, SAMPLE_PROFILES } from '../backend/seed/clientSample';
import { runRepeatingDue } from '../backend/services/invoices';
import { generateDue as generateRecurringDue } from '../backend/services/recurring';
import { openWebDatabase, type WebDB } from './sqljs-db';
import { SCHEMA_SQL } from './generated/schema-sql';

const IDB_NAME = 'book-of-business';
const IDB_STORE = 'sqlite';
const IDB_KEY = 'main';

let webDb: WebDB | null = null;
let persistTimer: number | null = null;
let storageOk = true;

/** Multiple sets of books ("clients"), each its own SQLite file. */
type BooksEntry = { id: string; name: string };
type BooksRegistry = { active: string; books: BooksEntry[]; samples_v1?: boolean };
let registry: BooksRegistry = { active: 'main', books: [{ id: 'main', name: 'My books' }] };
const REGISTRY_KEY = '__books_registry__';
const bytesKey = (id: string) => (id === 'main' ? 'main' : `books:${id}`);

// ── IndexedDB persistence ──────────────────────────────────────────────────

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbLoad(key: string = IDB_KEY): Promise<Uint8Array | undefined> {
  try {
    const d = await idb();
    return await new Promise((resolve, reject) => {
      const tx = d.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result ? new Uint8Array(req.result) : undefined);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn('IndexedDB unavailable; data will not survive closing the tab.', e);
    storageOk = false;
    return undefined;
  }
}

async function idbSave(bytes: Uint8Array, key: string = bytesKey(registry.active)): Promise<void> {
  if (!storageOk) return;
  try {
    const d = await idb();
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(bytes.buffer.slice(0), key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn('Persist failed:', e);
    storageOk = false;
  }
}

async function idbGetRaw(key: string): Promise<any> {
  try {
    const d = await idb();
    return await new Promise((resolve, reject) => {
      const tx = d.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch { return undefined; }
}

async function loadRegistry(): Promise<void> {
  const raw = await idbGetRaw(REGISTRY_KEY);
  if (raw && typeof raw === 'object' && Array.isArray(raw.books) && raw.books.length) {
    registry = raw as BooksRegistry;
    if (!registry.books.some((b) => b.id === registry.active)) registry.active = registry.books[0].id;
  }
}

async function saveRegistry(): Promise<void> {
  if (!storageOk) return;
  try {
    const d = await idb();
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(JSON.parse(JSON.stringify(registry)), REGISTRY_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) { console.warn('Registry persist failed:', e); }
}

async function flushNow(): Promise<void> {
  if (persistTimer != null) { window.clearTimeout(persistTimer); persistTimer = null; }
  if (webDb) await idbSave(webDb.exportBytes());
}

function schedulePersist() {
  if (persistTimer != null) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    if (webDb) void idbSave(webDb.exportBytes());
  }, 350);
}

export function persistenceAvailable(): boolean {
  return storageOk;
}

// ── Downloads / printing ───────────────────────────────────────────────────

function download(data: BlobPart, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function printHtml(html: string): Promise<void> {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.style.position = 'fixed';
    frame.style.right = '0';
    frame.style.bottom = '0';
    frame.style.width = '0';
    frame.style.height = '0';
    frame.style.border = '0';
    document.body.appendChild(frame);
    const doc = frame.contentWindow!.document;
    doc.open();
    doc.write(html);
    doc.close();
    frame.onload = () => {
      try {
        frame.contentWindow!.focus();
        frame.contentWindow!.print();
      } finally {
        window.setTimeout(() => {
          frame.remove();
          resolve();
        }, 800);
      }
    };
    // Some engines fire load before onload is attached; nudge it.
    window.setTimeout(() => {
      try {
        frame.contentWindow!.focus();
        frame.contentWindow!.print();
      } catch {
        /* already printed */
      }
    }, 250);
  });
}

function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    // Cancel: resolve null when focus returns without a change event.
    window.addEventListener('focus', () => window.setTimeout(() => resolve(null), 600), { once: true });
    input.click();
  });
}

// ── Boot ───────────────────────────────────────────────────────────────────

export async function bootWebBridge(): Promise<{ fresh: boolean }> {
  await loadRegistry();
  const entry = registry.books.find((b) => b.id === registry.active)!;
  const saved = await idbLoad(bytesKey(registry.active));
  webDb = await openWebDatabase(saved);
  let fresh = false;

  if (!saved) {
    webDb.exec(SCHEMA_SQL);
    fresh = true;
  } else {
    // Same on-open integrity guarantee as the desktop build.
    const bad = webDb
      .prepare(
        `SELECT j.id FROM journals j JOIN journal_lines l ON l.journal_id = j.id
         WHERE j.status='POSTED' GROUP BY j.id HAVING SUM(l.debit) <> SUM(l.credit)`
      )
      .all();
    if (bad.length) throw new Error(`Ledger integrity failure: ${bad.length} unbalanced journal(s)`);
  }

  runMigrations(webDb);
  setDb(webDb);
  if (fresh) {
    if (registry.active === 'main' && registry.books.length === 1) {
      seedDemo();
    } else {
      // A new client's books: clean ledger, carrying the chosen name.
      try {
        call('settings.updateOrganisation', [{ legal_name: entry.name, trading_name: entry.name }]);
      } catch (e) {
        console.warn('Service stamp failed, writing the name directly:', e);
        try {
          webDb.prepare('UPDATE organisations SET legal_name = ?, trading_name = ?').run(entry.name, entry.name);
        } catch (e2) { console.warn('Could not stamp organisation name:', e2); }
      }
    }
  }
  // Keep the switcher label in sync with the books' own organisation name —
  // but never let the schema's placeholder overwrite a real chosen name.
  try {
    const org = call('settings.getOrganisation', []) as any;
    const nm = org?.trading_name || org?.legal_name;
    const placeholder = !nm || /^My Company/i.test(nm);
    if (!placeholder && entry.name !== nm) {
      entry.name = nm;
    } else if (placeholder && entry.name && !/^My Company/i.test(entry.name)) {
      // The books still carry the default — repair them from the registry.
      try {
        call('settings.updateOrganisation', [{ legal_name: entry.name, trading_name: entry.name }]);
      } catch { /* fine */ }
    }
  } catch { /* fine */ }
  void saveRegistry();
  try {
    runRepeatingDue();
  } catch (e) {
    console.warn('Repeating invoice run failed:', e);
  }
  try {
    // Canonical recurring templates (the Recurring screen) must also generate at
    // boot, not only when the React UI mounts — otherwise an automated/headless
    // boot never creates due recurring invoices.
    generateRecurringDue();
  } catch (e) {
    console.warn('Recurring template run failed:', e);
  }

  // First boot of this build: create two fully-worked sample organisations
  // (50+ transactions each) so multi-client books can be explored at once.
  // Runs exactly once per browser; they can be removed in Settings.
  if (storageOk && !registry.samples_v1) {
    try {
      for (const profile of SAMPLE_PROFILES) {
        if (registry.books.some((b) => b.name === profile.org)) continue;
        const sampleDb = await openWebDatabase(undefined);
        sampleDb.exec(SCHEMA_SQL);
        runMigrations(sampleDb);
        setDb(sampleDb);
        try {
          seedClientSample(profile);
          call('settings.updateOrganisation', [{ legal_name: profile.org, trading_name: profile.org }]);
          const id = `sample-${profile.seed}`;
          await idbSave(sampleDb.exportBytes(), bytesKey(id));
          registry.books.push({ id, name: profile.org });
        } finally {
          setDb(webDb);
        }
      }
      registry.samples_v1 = true;
      await saveRegistry();
    } catch (e) {
      console.warn('Sample organisations could not be created:', e);
      setDb(webDb);
    }
  }
  schedulePersist();

  window.bridge = {
    api: async (path: string, ...args: unknown[]) => {
      // Books management lives in the bridge, not the ledger services.
      if (path === 'books.list') {
        return { ok: true, data: { active: registry.active, books: registry.books, storage_ok: storageOk } };
      }
      if (path === 'books.create') {
        if (!storageOk) return { ok: false, error: 'This browser is blocking storage, so separate client books can\u2019t be kept here.' };
        const name = String(args[0] ?? '').trim();
        if (!name) return { ok: false, error: 'Give the new client a name' };
        await flushNow();
        const id = `b${Date.now().toString(36)}`;
        registry.books.push({ id, name });
        registry.active = id;
        await saveRegistry();
        return { ok: true, data: { id } };
      }
      if (path === 'books.delete') {
        if (!storageOk) return { ok: false, error: 'This browser is blocking storage, so books can\u2019t be managed here.' };
        const id = String(args[0] ?? '');
        if (registry.books.length <= 1) return { ok: false, error: 'These are the only books — there\u2019d be nothing left to open.' };
        if (!registry.books.some((b) => b.id === id)) return { ok: false, error: 'Those books no longer exist' };
        try {
          const d = await idb();
          await new Promise<void>((resolve, reject) => {
            const tx = d.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).delete(bytesKey(id));
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });
        } catch (e: any) {
          return { ok: false, error: 'Could not remove the stored books: ' + (e?.message ?? e) };
        }
        registry.books = registry.books.filter((b) => b.id !== id);
        if (registry.active === id) registry.active = registry.books[0].id;
        await saveRegistry();
        return { ok: true, data: { active: registry.active } };
      }
      if (path === 'books.switch') {
        if (!storageOk) return { ok: false, error: 'This browser is blocking storage, so separate client books can\u2019t be kept here.' };
        const id = String(args[0] ?? '');
        if (!registry.books.some((b) => b.id === id)) return { ok: false, error: 'Those books no longer exist' };
        await flushNow();
        registry.active = id;
        await saveRegistry();
        return { ok: true, data: { id } };
      }
      try {
        const data = await call(path, args ?? []);
        schedulePersist();
        return { ok: true, data };
      } catch (e: any) {
        return { ok: false, error: e?.message ?? String(e) };
      }
    },

    exportPdf: async (html: string, _name: string) => {
      try {
        await printHtml(html);
        return { ok: true };
      } catch (e: any) {
        return { ok: false, error: e?.message ?? String(e) };
      }
    },

    saveCsv: async (csv: string, name: string) => {
      download(csv, name, 'text/csv;charset=utf-8');
      return { ok: true };
    },

    backup: async () => {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      download(webDb!.exportBytes().slice().buffer, `book-of-business-backup-${stamp}.db`, 'application/octet-stream');
      return { ok: true };
    },

    restore: async () => {
      const file = await pickFile('.db,application/octet-stream');
      if (!file) return { ok: false, error: 'cancelled' };
      if (!window.confirm('Restoring a backup replaces ALL current data in this browser. Continue?')) {
        return { ok: false, error: 'cancelled' };
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Validate it opens and balances before committing it.
      const candidate = await openWebDatabase(bytes);
      const bad = candidate
        .prepare(
          `SELECT j.id FROM journals j JOIN journal_lines l ON l.journal_id = j.id
           WHERE j.status='POSTED' GROUP BY j.id HAVING SUM(l.debit) <> SUM(l.credit)`
        )
        .all();
      candidate.close();
      if (bad.length) return { ok: false, error: 'That file failed the ledger integrity check.' };
      await idbSave(bytes);
      window.location.reload();
      return { ok: true };
    },
  };

  return { fresh };
}
