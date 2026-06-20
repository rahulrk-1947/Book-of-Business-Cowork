/**
 * Electron main process. Owns the database; routes every renderer request
 * through the service registry over a single 'api' IPC channel.
 */
import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { join } from 'node:path';
import { existsSync, copyFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { initDatabase, getDb } from '../src/backend/db';
import { call } from '../src/backend/registry';
import { runRepeatingDue } from '../src/backend/services/invoices';
import { generateDue as generateRecurringDue } from '../src/backend/services/recurring';
import { seedDemo } from '../src/backend/seed/demo';

const isDev = process.argv.includes('--dev');
let win: BrowserWindow | null = null;

function dbPath(): string {
  const dir = app.getPath('userData');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'book-of-business.db');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 1024,
    minHeight: 640,
    title: 'Book of Business',
    backgroundColor: '#f4f6f8',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (isDev) {
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(join(__dirname, '../dist/index.html'));
  }
  win.on('closed', () => (win = null));
}

app.whenReady().then(() => {
  const path = dbPath();
  const isNew = !existsSync(path);
  initDatabase(path);
  if (isNew) {
    try {
      seedDemo(); // demo-ready on first launch (spec deliverables)
    } catch (e) {
      console.error('Demo seed failed:', e);
    }
  }
  try {
    const made = runRepeatingDue(); // generate any due recurring invoices (legacy templates)
    if (made.length) console.log(`Generated ${made.length} repeating invoice(s)`);
  } catch (e) {
    console.error('Repeating invoice run failed:', e);
  }
  try {
    // Canonical recurring templates (the Recurring screen) — generate at boot so
    // they don't depend on the React UI mounting.
    const r = generateRecurringDue();
    if (r?.count) console.log(`Generated ${r.count} recurring invoice(s)`);
  } catch (e) {
    console.error('Recurring template run failed:', e);
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC: service routing ───────────────────────────────────────────────────

ipcMain.handle('api', async (_evt, path: string, args: unknown[]) => {
  try {
    return { ok: true, data: await call(path, args ?? []) };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
});

// ── IPC: PDF export (invoice/report HTML → PDF via offscreen window) ───────

ipcMain.handle('export-pdf', async (_evt, html: string, suggestedName: string) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win!, {
    defaultPath: suggestedName,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return { ok: false, error: 'cancelled' };
  const printer = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await printer.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const pdf = await printer.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 },
    });
    writeFileSync(filePath, pdf);
    shell.showItemInFolder(filePath);
    return { ok: true, path: filePath };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  } finally {
    printer.destroy();
  }
});

// ── IPC: CSV save ──────────────────────────────────────────────────────────

ipcMain.handle('save-csv', async (_evt, csv: string, suggestedName: string) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win!, {
    defaultPath: suggestedName,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (canceled || !filePath) return { ok: false, error: 'cancelled' };
  writeFileSync(filePath, csv, 'utf8');
  shell.showItemInFolder(filePath);
  return { ok: true, path: filePath };
});

// ── IPC: backup / restore ──────────────────────────────────────────────────

ipcMain.handle('backup', async () => {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const { canceled, filePath } = await dialog.showSaveDialog(win!, {
    defaultPath: `book-of-business-backup-${stamp}.db`,
    filters: [{ name: 'SQLite database', extensions: ['db'] }],
  });
  if (canceled || !filePath) return { ok: false, error: 'cancelled' };
  try {
    await getDb().backup(filePath);
    return { ok: true, path: filePath };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
});

ipcMain.handle('restore', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win!, {
    filters: [{ name: 'SQLite database', extensions: ['db'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths[0]) return { ok: false, error: 'cancelled' };
  const confirm = await dialog.showMessageBox(win!, {
    type: 'warning',
    buttons: ['Cancel', 'Overwrite and restart'],
    defaultId: 0,
    message: 'Restoring a backup replaces ALL current data. Continue?',
  });
  if (confirm.response !== 1) return { ok: false, error: 'cancelled' };
  const target = dbPath();
  // Safety copy of the current file before overwriting.
  try {
    copyFileSync(target, target + '.pre-restore');
  } catch {}
  copyFileSync(filePaths[0], target);
  app.relaunch();
  app.exit(0);
  return { ok: true };
});
